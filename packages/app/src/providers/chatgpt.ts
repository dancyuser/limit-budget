// Адаптер-заглушка провайдера chatgpt (ChatGPT Desktop, Codex). Весь источник в одном файле.
//
// Документированные источники (формат подтверждается отдельным этапом после шага 0):
//  1. локальные rollout-логи Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, строки с rate_limits
//     (primary — 5-часовое окно, secondary — недельное; у части тарифов одного из них нет);
//  2. codex app-server;
//  3. страница использования ChatGPT / список облачных задач через вход в ChatGPT (облачный Codex в локальных логах может не отражаться).
// Пока включена заглушка: данные берутся из обезличенных фикстур, ядро и база не меняются.
// Реальное чтение сводится к замене RolloutSource на источник, читающий каталог сессий.
import type { ProviderCapabilities, TaskRun, UsageProvider, WindowSnapshot } from '@limit-budget/core';
import { ShapeError } from '../shared/errors.js';

export const CHATGPT_CAPABILITIES: ProviderCapabilities = {
  // Окна необязательны: у Pro пятичасового нет, у части Plus-аккаунтов оно пропало.
  windows: ['5h', '7d'],
  surfaces: ['codex_local', 'codex_cloud'],
  modelBreakdown: true,
  effort: true,
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Источник строк rollout. Заглушка отдаёт фикстуры, настоящий — читает каталог сессий. */
export interface RolloutSource {
  /** Строки JSONL в порядке записи (старые первыми). */
  readLines(): Promise<string[]>;
}

export class StaticRolloutSource implements RolloutSource {
  constructor(private lines: () => string[]) {}
  async readLines(): Promise<string[]> {
    return this.lines();
  }
}

export interface ParsedRateLimits {
  ts: number | null;
  plan: string | null;
  /** Идентификатор корзины лимитов из лога (на реальных логах встречается, например, `premium`); окон у части записей нет. */
  limitId: string | null;
  primary: { usedPct: number; windowMinutes: number | null; resetsAt: number | null } | null;
  secondary: { usedPct: number; windowMinutes: number | null; resetsAt: number | null } | null;
}

function readWindow(o: unknown, tsMs: number | null) {
  if (!isObj(o)) return null;
  const pct = o.used_percent ?? o.usedPercent;
  if (typeof pct !== 'number') return null;
  const winMin = typeof o.window_minutes === 'number' ? o.window_minutes : typeof o.windowMinutes === 'number' ? o.windowMinutes : null;
  let resetsAt: number | null = null;
  if (typeof o.resets_at === 'number') resetsAt = o.resets_at < 1e12 ? o.resets_at * 1000 : o.resets_at;
  else if (typeof o.resets_in_seconds === 'number' && tsMs !== null) resetsAt = tsMs + o.resets_in_seconds * 1000;
  return { usedPct: Math.min(100, Math.max(0, pct)), windowMinutes: winMin, resetsAt };
}

/** Одна строка rollout → лимиты, если в ней есть rate_limits. */
export function parseRateLimitsLine(line: string): ParsedRateLimits | null {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  const payload = isObj(j.payload) ? j.payload : j;
  const rl = payload.rate_limits ?? payload.rateLimits;
  if (!isObj(rl)) return null;
  const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : null;
  const tsMs = ts !== null && Number.isFinite(ts) ? ts : null;
  return {
    ts: tsMs,
    plan: typeof rl.plan_type === 'string' ? rl.plan_type : null,
    limitId: typeof rl.limit_id === 'string' ? rl.limit_id : null,
    primary: readWindow(rl.primary, tsMs),
    secondary: readWindow(rl.secondary, tsMs),
  };
}

/** Последние известные лимиты из набора строк. */
export function latestRateLimits(lines: string[]): ParsedRateLimits | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = parseRateLimitsLine(lines[i]);
    if (r && (r.primary || r.secondary)) return r;
  }
  return null;
}

/** Задачи: от task_started до task_complete; модель и режим берутся из ближайшего turn_context. */
export function parseTasks(lines: string[]): TaskRun[] {
  const out: TaskRun[] = [];
  let model: string | undefined;
  let effort: string | undefined;
  let openStart: Date | null = null;
  for (const line of lines) {
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(j)) continue;
    const payload = isObj(j.payload) ? j.payload : {};
    const ts = typeof j.timestamp === 'string' ? new Date(j.timestamp) : null;
    if (j.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
      const eff = payload.effort ?? payload.reasoning_effort;
      if (typeof eff === 'string') effort = eff;
    }
    const kind = payload.type;
    if (kind === 'task_started' && ts) openStart = ts;
    if (kind === 'task_complete' && ts && openStart) {
      out.push({ start: openStart, end: ts, surface: 'codex_local', model, effort, source: 'rollout' });
      openStart = null;
    }
  }
  return out;
}

export class ChatGptProvider implements UsageProvider {
  readonly id = 'chatgpt' as const;
  readonly source: string;
  readonly capabilities = CHATGPT_CAPABILITIES;

  constructor(
    private rollouts: RolloutSource,
    opts: { source?: string } = {},
  ) {
    this.source = opts.source ?? 'codex-rollout';
  }

  async poll(): Promise<WindowSnapshot[]> {
    const lines = await this.rollouts.readLines();
    const r = latestRateLimits(lines);
    if (!r) throw new ShapeError('В rollout-логах нет записей rate_limits');
    const out: WindowSnapshot[] = [];
    // Окна различаем по длине, а не по имени primary/secondary: на части тарифов остаётся одно окно.
    for (const w of [r.primary, r.secondary]) {
      if (!w) continue;
      const weekly = (w.windowMinutes ?? 0) >= 24 * 60;
      out.push({
        window: weekly ? '7d' : '5h',
        bucket: 'all',
        usedPct: w.usedPct,
        resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt),
      });
    }
    return out;
  }

  async tasks(): Promise<TaskRun[]> {
    return parseTasks(await this.rollouts.readLines());
  }
}
