// Адаптер Claude: весь источник в одном файле, чтобы при смене формата менять только его.
//
// Источник — внутренний эндпоинт claude.ai, который питает страницу Settings → Usage. Он неофициальный:
// имена полей взяты из сторонних проектов и подтверждаются на шаге 0 (docs/data-sources.md).
// Запрос делается изнутри страницы claude.ai (через PageFetcher), потому что внешним клиентам мешает Cloudflare.
import type { Bucket, ProviderCapabilities, UsageProvider, WindowName, WindowSnapshot } from '@limit-budget/core';
import { AuthRequiredError, NetworkError, ShapeError } from '../shared/errors.js';

/** Что нужно адаптеру от окружения: выполнить fetch в контексте залогиненной страницы claude.ai. */
export interface PageFetcher {
  fetchJson(path: string): Promise<{ status: number; json: unknown; text?: string }>;
}

export interface ClaudeProviderOptions {
  getOrgId(): string | null;
  setOrgId(id: string): void;
  /** Путь эндпоинта использования; `{org}` заменяется на идентификатор организации. */
  usagePath?: string;
}

export const CLAUDE_USAGE_PATH = '/api/organizations/{org}/usage';
export const CLAUDE_ORGS_PATH = '/api/organizations';

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  windows: ['5h', '7d'],
  surfaces: ['chat'],
  modelBreakdown: false,
  effort: false,
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Сопоставление ключей ответа и окон. Недельные срезы по моделям есть не на всех тарифах. */
const ENTRIES: Array<{ keys: string[]; window: WindowName; bucket: Bucket }> = [
  { keys: ['five_hour', 'fiveHour', '5h'], window: '5h', bucket: 'all' },
  { keys: ['seven_day', 'sevenDay', '7d', 'weekly'], window: '7d', bucket: 'all' },
  { keys: ['seven_day_sonnet', 'sevenDaySonnet'], window: '7d', bucket: 'sonnet' },
  { keys: ['seven_day_opus', 'sevenDayOpus'], window: '7d', bucket: 'opus' },
];

const PCT_KEYS = ['utilization', 'used_percentage', 'used_percent', 'percent_used', 'usedPct', 'utilization_pct'];
const RESET_KEYS = ['resets_at', 'resetsAt', 'reset_at', 'resets'];

function readPct(o: Json): number | null {
  for (const k of PCT_KEYS) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.min(100, Math.max(0, v));
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.min(100, Math.max(0, Number(v)));
  }
  return null;
}

function readReset(o: Json): Date | null {
  for (const k of RESET_KEYS) {
    const v = o[k];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return new Date(t);
    }
    if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v);
  }
  return null;
}

/**
 * Разбор ответа эндпоинта использования. Пустые срезы (null) пропускаются; если нет ни 5-часового,
 * ни недельного окна, это изменение формата и адаптер сообщает об этом, а не отдаёт нули.
 */
export function parseUsage(json: unknown): WindowSnapshot[] {
  if (!isObj(json)) throw new ShapeError('Ответ использования не объект');
  const root = isObj(json.usage) ? json.usage : json;
  const out: WindowSnapshot[] = [];
  for (const e of ENTRIES) {
    const key = e.keys.find((k) => isObj(root[k]));
    if (!key) continue;
    const entry = root[key] as Json;
    const usedPct = readPct(entry);
    if (usedPct === null) continue;
    out.push({ window: e.window, bucket: e.bucket, usedPct, resetsAt: readReset(entry) });
  }
  if (!out.some((s) => s.bucket === 'all')) {
    throw new ShapeError(`В ответе нет окон five_hour / seven_day (ключи: ${Object.keys(root).slice(0, 12).join(', ')})`);
  }
  return out;
}

/** Выбор организации: первая с возможностью chat, иначе первая в списке. */
export function pickOrganization(json: unknown): string {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.organizations) ? json.organizations : [];
  const orgs = list.filter(isObj);
  const chat = orgs.find((o) => Array.isArray(o.capabilities) && (o.capabilities as unknown[]).includes('chat'));
  const pick = chat ?? orgs[0];
  const id = pick && (pick.uuid ?? pick.id);
  if (typeof id !== 'string') throw new ShapeError('В списке организаций claude.ai нет идентификатора');
  return id;
}

function looksLikeCloudflare(text?: string): boolean {
  return !!text && /just a moment|cf-chl|challenge-platform/i.test(text);
}

export class ClaudeProvider implements UsageProvider {
  readonly id = 'claude' as const;
  readonly source = 'claude-web';
  readonly capabilities = CLAUDE_CAPABILITIES;

  constructor(
    private fetcher: PageFetcher,
    private opts: ClaudeProviderOptions,
  ) {}

  private async get(path: string): Promise<unknown> {
    const res = await this.fetcher.fetchJson(path);
    // status 0 — запрос не дошёл до сервера (нет сети, прокси не отвечает, неверный порт).
    if (res.status === 0) throw new NetworkError('Нет связи с claude.ai: проверьте интернет и настройки прокси');
    if (res.status === 401 || (res.status === 403 && !looksLikeCloudflare(res.text))) throw new AuthRequiredError();
    if (looksLikeCloudflare(res.text)) throw new Error('Cloudflare просит проверку: откройте окно входа и пройдите её один раз');
    if (res.status < 200 || res.status >= 300) throw new Error(`claude.ai ответил ${res.status}`);
    return res.json;
  }

  private async orgId(): Promise<string> {
    const cached = this.opts.getOrgId();
    if (cached) return cached;
    const id = pickOrganization(await this.get(CLAUDE_ORGS_PATH));
    this.opts.setOrgId(id);
    return id;
  }

  async poll(): Promise<WindowSnapshot[]> {
    const org = await this.orgId();
    const path = (this.opts.usagePath ?? CLAUDE_USAGE_PATH).replace('{org}', encodeURIComponent(org));
    return parseUsage(await this.get(path));
  }
}
