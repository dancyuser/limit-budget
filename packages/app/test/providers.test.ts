import { describe, expect, it } from 'vitest';
import { ClaudeProvider, parseUsage, pickOrganization, type PageFetcher } from '../src/providers/claude.js';
import {
  ChatGptProvider,
  StaticRolloutSource,
  latestRateLimits,
  parseRateLimitsLine,
  parseTasks,
} from '../src/providers/chatgpt.js';
import { CLAUDE_ORGS_FIXTURE, claudeUsageFixture, codexRolloutFixture } from '../src/providers/fixtures.js';
import { AuthRequiredError, NetworkError, ShapeError } from '../src/shared/errors.js';

const NOW = Date.parse('2026-11-03T09:00:00Z');

function fetcher(routes: Record<string, { status?: number; json?: unknown; text?: string }>): PageFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchJson(path) {
      calls.push(path);
      const r = routes[path];
      if (!r) return { status: 404, json: null };
      return { status: r.status ?? 200, json: r.json ?? null, text: r.text };
    },
  };
}

describe('Claude: разбор ответа эндпоинта использования', () => {
  it('читает 5-часовое, недельное окна и недельные срезы по моделям', () => {
    const snaps = parseUsage(claudeUsageFixture(NOW));
    const by = (w: string, b: string) => snaps.find((s) => s.window === w && s.bucket === b);
    expect(by('5h', 'all')?.usedPct).toBe(34);
    expect(by('7d', 'all')?.usedPct).toBe(41);
    expect(by('7d', 'sonnet')?.usedPct).toBe(12.5);
    expect(by('7d', 'opus')).toBeUndefined(); // null-срез пропускается
    expect(by('5h', 'all')?.resetsAt?.getTime()).toBe(NOW + 2.5 * 3_600_000);
  });

  it('терпим к вложенному usage, альтернативным именам и числовым меткам времени', () => {
    const snaps = parseUsage({
      usage: {
        five_hour: { used_percentage: 10, resets_at: Math.floor(NOW / 1000) },
        seven_day: { utilization: '25.5', resets_at: null },
      },
    });
    expect(snaps.find((s) => s.window === '5h')?.resetsAt?.getTime()).toBe(Math.floor(NOW / 1000) * 1000);
    expect(snaps.find((s) => s.window === '7d')).toMatchObject({ usedPct: 25.5, resetsAt: null });
  });

  it('значения вне 0–100 обрезаются', () => {
    const snaps = parseUsage({ five_hour: { utilization: 130 }, seven_day: { utilization: -3 } });
    expect(snaps.map((s) => s.usedPct)).toEqual([100, 0]);
  });

  it('если окон нет, сообщает об изменении формата, а не отдаёт нули', () => {
    expect(() => parseUsage({ something_else: { utilization: 1 } })).toThrow(ShapeError);
    expect(() => parseUsage('oops')).toThrow(ShapeError);
  });

  it('выбирает организацию с возможностью chat', () => {
    expect(pickOrganization(CLAUDE_ORGS_FIXTURE)).toBe('00000000-0000-4000-8000-000000000001');
    expect(
      pickOrganization([
        { uuid: 'a', capabilities: ['api'] },
        { uuid: 'b', capabilities: ['chat', 'claude_pro'] },
      ]),
    ).toBe('b');
    expect(() => pickOrganization([])).toThrow(ShapeError);
  });
});

describe('Claude: провайдер', () => {
  const org = '00000000-0000-4000-8000-000000000001';

  it('находит организацию один раз и опрашивает эндпоинт использования', async () => {
    const f = fetcher({
      '/api/organizations': { json: CLAUDE_ORGS_FIXTURE },
      [`/api/organizations/${org}/usage`]: { json: claudeUsageFixture(NOW) },
    });
    let stored: string | null = null;
    const p = new ClaudeProvider(f, { getOrgId: () => stored, setOrgId: (id) => (stored = id) });
    expect((await p.poll()).length).toBe(3);
    expect(stored).toBe(org);
    await p.poll();
    expect(f.calls.filter((c) => c === '/api/organizations')).toHaveLength(1);
    expect(p.capabilities.windows).toEqual(['5h', '7d']);
  });

  it('status 0 (запрос не дошёл) — ошибка связи с подсказкой про прокси', async () => {
    const p = new ClaudeProvider(fetcher({ [`/api/organizations/${org}/usage`]: { status: 0, text: 'TypeError: Failed to fetch' } }), { getOrgId: () => org, setOrgId: () => {} });
    await expect(p.poll()).rejects.toBeInstanceOf(NetworkError);
    await expect(p.poll()).rejects.toThrow(/прокси/);
  });

  it('401 — нужен вход, Cloudflare — отдельная ошибка, 500 — обычная', async () => {
    const mk = (r: { status: number; text?: string }) =>
      new ClaudeProvider(fetcher({ [`/api/organizations/${org}/usage`]: r }), { getOrgId: () => org, setOrgId: () => {} });
    await expect(mk({ status: 401 }).poll()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(mk({ status: 403, text: '<title>Just a moment...</title>' }).poll()).rejects.toThrow(/Cloudflare/);
    await expect(mk({ status: 500 }).poll()).rejects.toThrow(/500/);
  });
});

describe('ChatGPT / Codex: контрактные тесты на обезличенных фикстурах rollout', () => {
  const lines = codexRolloutFixture(NOW);

  it('находит последние rate_limits и различает окна по длине', async () => {
    const p = new ChatGptProvider(new StaticRolloutSource(() => lines));
    const snaps = await p.poll();
    expect(snaps.find((s) => s.window === '5h')?.usedPct).toBe(31);
    expect(snaps.find((s) => s.window === '7d')?.usedPct).toBe(29);
    expect(p.capabilities.surfaces).toEqual(['codex_local', 'codex_cloud']);
  });

  it('без 5-часового окна (тариф Pro) отдаёт только недельное', async () => {
    const weeklyOnly = JSON.stringify({
      timestamp: new Date(NOW).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { secondary: { used_percent: 12, window_minutes: 10080, resets_in_seconds: 86_400 } } },
    });
    const snaps = await new ChatGptProvider(new StaticRolloutSource(() => [weeklyOnly])).poll();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].window).toBe('7d');
    expect(snaps[0].resetsAt?.getTime()).toBe(NOW + 86_400_000);
  });

  it('если записей rate_limits нет, адаптер сообщает об этом', async () => {
    await expect(new ChatGptProvider(new StaticRolloutSource(() => ['{"type":"noise"}', 'не json'])).poll()).rejects.toBeInstanceOf(ShapeError);
  });

  it('форма реальных логов: последняя запись с limit_id и окнами null пропускается, берётся ближайшая с окнами', async () => {
    // Обезличенная запись из отчёта шага 0 на машине пользователя (limit_id = premium, окон нет)
    const real = JSON.stringify({
      timestamp: new Date(NOW).toISOString(),
      ordinal: 27,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: {}, last_token_usage: {}, model_context_window: 475000 },
        rate_limits: {
          limit_id: 'premium',
          limit_name: null,
          primary: null,
          secondary: null,
          credits: { has_credits: false, unlimited: false, balance: '0' },
          individual_limit: null,
          spend_control_reached: null,
          plan_type: 'plus',
          rate_limit_reached_type: null,
        },
      },
    });
    const parsed = parseRateLimitsLine(real)!;
    expect(parsed.limitId).toBe('premium');
    expect(parsed.plan).toBe('plus');
    expect(parsed.primary).toBeNull();
    const withWindows = lines.filter((l) => l.includes('used_percent'));
    const snaps = await new ChatGptProvider(new StaticRolloutSource(() => [...withWindows, real])).poll();
    expect(snaps.find((s) => s.window === '7d')?.usedPct).toBe(29);
  });

  it('парсер строки устойчив к мусору', () => {
    expect(parseRateLimitsLine('')).toBeNull();
    expect(parseRateLimitsLine('[]')).toBeNull();
    expect(latestRateLimits(['x', '{}'])).toBeNull();
  });

  it('задачи берутся от task_started до task_complete с моделью и режимом из turn_context', () => {
    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ model: 'gpt-5-codex', effort: 'medium', source: 'rollout' });
    expect(tasks[1].effort).toBe('high');
    expect(tasks[0].end!.getTime()).toBeGreaterThan(tasks[0].start.getTime());
  });

  it('в фикстурах нет текстов разговоров и реальных путей', () => {
    const blob = lines.join('\n');
    expect(blob).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
    expect(blob).toContain('[текст не сохраняется]');
  });
});
