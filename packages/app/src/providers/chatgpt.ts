// Адаптер провайдера chatgpt (ChatGPT Desktop, Codex). Разбор записей в одном файле, чтение каталога сессий — в codexFiles.ts.
//
// Источник: локальные rollout-логи Codex, ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, строки с rate_limits
// (primary — 5-часовое окно, secondary — недельное; у части тарифов одного из них нет). Входа в аккаунт не нужно:
// читаются только числа окон, а также время и модель задач. Облачный Codex в локальных логах может не отражаться.
// Другие возможные источники: codex app-server, страница использования ChatGPT через вход в ChatGPT.
// В демо-режиме и в тестах вместо каталога читаются обезличенные фикстуры (StaticRolloutSource).
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

/** Источник строк rollout. Фикстуры отдаёт StaticRolloutSource, настоящий каталог сессий читает CodexRolloutSource. */
export interface RolloutSource {
  /** Строки JSONL всех файлов: файлы от старых к новым, внутри файла в порядке записи. */
  readLines(): Promise<string[]>;
  /** Строки по файлам (старые файлы первыми): задачи и модель нельзя разбирать по склеенному потоку, иначе модель одного сеанса перейдёт в другой. */
  readFiles?(): Promise<string[][]>;
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

/** Основная корзина лимитов Codex: `codex`; в старых логах `limit_id` может не быть. Корзина `premium` и другие — отдельные, окон у них обычно нет. */
const isMainBucket = (r: ParsedRateLimits) => r.limitId === null || r.limitId === 'codex';

/**
 * Последние известные лимиты из набора строк. Берётся самая свежая по времени записи запись с окнами, причём запись
 * основной корзины важнее записи другой корзины: параллельные сеансы пишут в разные файлы, и последняя строка набора не всегда самая новая.
 */
export function latestRateLimits(lines: string[]): ParsedRateLimits | null {
  let best: ParsedRateLimits | null = null;
  for (const line of lines) {
    // Строк без rate_limits в логе подавляющее большинство; JSON разбираем только для нужных.
    if (!line.includes('rate_limits') && !line.includes('rateLimits')) continue;
    const r = parseRateLimitsLine(line);
    if (!r || (!r.primary && !r.secondary)) continue;
    if (best === null) {
      best = r;
      continue;
    }
    const mainNow = isMainBucket(r);
    const mainBest = isMainBucket(best);
    if (mainNow !== mainBest) {
      if (mainNow) best = r;
    } else if ((r.ts ?? -Infinity) >= (best.ts ?? -Infinity)) {
      best = r;
    }
  }
  return best;
}

/** Задачи: от task_started до task_complete; модель и режим берутся из ближайшего turn_context. */
export function parseTasks(lines: string[]): TaskRun[] {
  const out: TaskRun[] = [];
  let model: string | undefined;
  let effort: string | undefined;
  let openStart: Date | null = null;
  for (const line of lines) {
    // Большинство строк лога — вывод инструментов и текст ответов: разбираем JSON только у нужных.
    if (!line.includes('task_started') && !line.includes('task_complete') && !line.includes('turn_context')) continue;
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

  private now: () => number;

  constructor(
    private rollouts: RolloutSource,
    opts: { source?: string; /** Часы: нужны, чтобы понять, что окно из лога уже сброшено (в тестах и демо — виртуальные). */ now?: () => number } = {},
  ) {
    this.source = opts.source ?? 'codex-rollout';
    this.now = opts.now ?? Date.now;
  }

  async poll(): Promise<WindowSnapshot[]> {
    const lines = await this.rollouts.readLines();
    const r = latestRateLimits(lines);
    if (!r) throw new ShapeError('В rollout-логах нет записей rate_limits');
    const now = this.now();
    const out: WindowSnapshot[] = [];
    // Окна различаем по длине, а не по имени primary/secondary: на части тарифов остаётся одно окно.
    for (const w of [r.primary, r.secondary]) {
      if (!w) continue;
      const periodMs = (w.windowMinutes ?? 0) * 60_000;
      const weekly = (w.windowMinutes ?? 0) >= 24 * 60;
      let usedPct = w.usedPct;
      let resetsAt = w.resetsAt;
      // Лог пишется только пока работает Codex, поэтому последняя запись может быть старой. Если время сброса окна уже прошло,
      // расход в записи относится к прошлому окну: считаем окно пустым, а не показываем устаревшие проценты.
      if (resetsAt !== null && resetsAt <= now) {
        usedPct = 0;
        // 5-часовое окно открывается первым сообщением, следующего сброса пока нет; недельное идёт по той же сетке дальше.
        resetsAt = weekly && periodMs > 0 ? resetsAt + Math.ceil((now - resetsAt + 1) / periodMs) * periodMs : null;
      }
      out.push({
        window: weekly ? '7d' : '5h',
        bucket: 'all',
        usedPct,
        resetsAt: resetsAt === null ? null : new Date(resetsAt),
      });
    }
    return out;
  }

  async tasks(): Promise<TaskRun[]> {
    const files = this.rollouts.readFiles ? await this.rollouts.readFiles() : [await this.rollouts.readLines()];
    return files.flatMap((lines) => parseTasks(lines));
  }
}
