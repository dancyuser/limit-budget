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
    const p = new ChatGptProvider(new StaticRolloutSource(() => lines), { now: () => NOW });
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
    const snaps = await new ChatGptProvider(new StaticRolloutSource(() => [weeklyOnly]), { now: () => NOW }).poll();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].window).toBe('7d');
    expect(snaps[0].resetsAt?.getTime()).toBe(NOW + 86_400_000);
  });

  it('если записей rate_limits нет, адаптер сообщает об этом', async () => {
    await expect(new ChatGptProvider(new StaticRolloutSource(() => ['{"type":"noise"}', 'не json']), { now: () => NOW }).poll()).rejects.toBeInstanceOf(ShapeError);
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
    const snaps = await new ChatGptProvider(new StaticRolloutSource(() => [...withWindows, real]), { now: () => NOW }).poll();
    expect(snaps.find((s) => s.window === '7d')?.usedPct).toBe(29);
  });

  // Образец настоящей записи (значения со спайка 2026-10-31): основная корзина codex, 5ч 50%, неделя 100%.
  const rl = (ts: number, limitId: string | null, primary: [number, number] | null, secondary: [number, number] | null) =>
    JSON.stringify({
      timestamp: new Date(ts).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          ...(limitId ? { limit_id: limitId } : {}),
          plan_type: 'plus',
          primary: primary && { used_percent: primary[0], window_minutes: 300, resets_at: primary[1] / 1000 },
          secondary: secondary && { used_percent: secondary[0], window_minutes: 10080, resets_at: secondary[1] / 1000 },
        },
      },
    });
  const H = 3_600_000;

  it('запись из лога устарела: окно с прошедшим сбросом считается пустым, а не показывает старые 50%', async () => {
    // Запись сделана в 15:07, 5-часовое окно сбросилось в 17:15, спрашиваем в 19:46; недельное окно ещё идёт
    const rec = rl(NOW, 'codex', [50, NOW + 2 * H], [100, NOW + 5 * 24 * H]);
    const later = NOW + 4.6 * H;
    const snaps = await new ChatGptProvider(new StaticRolloutSource(() => [rec]), { now: () => later }).poll();
    const h5 = snaps.find((s) => s.window === '5h')!;
    expect(h5.usedPct).toBe(0);
    expect(h5.resetsAt).toBeNull();
    const d7 = snaps.find((s) => s.window === '7d')!;
    expect(d7.usedPct).toBe(100);
    expect(d7.resetsAt?.getTime()).toBe(NOW + 5 * 24 * H);
  });

  it('недельное окно тоже сбросилось: расход нулевой, следующий сброс — по той же недельной сетке', async () => {
    const rec = rl(NOW, 'codex', [10, NOW + 3 * H], [80, NOW + 24 * H]);
    const later = NOW + 24 * H + 3 * 24 * H; // через 3 суток после сброса
    const d7 = (await new ChatGptProvider(new StaticRolloutSource(() => [rec]), { now: () => later }).poll()).find((s) => s.window === '7d')!;
    expect(d7.usedPct).toBe(0);
    expect(d7.resetsAt!.getTime()).toBe(NOW + 24 * H + 7 * 24 * H);
    expect(d7.resetsAt!.getTime()).toBeGreaterThan(later);
  });

  it('до сброса значения берутся как есть', async () => {
    const rec = rl(NOW, 'codex', [50, NOW + 2 * H], [100, NOW + 5 * 24 * H]);
    const snaps = await new ChatGptProvider(new StaticRolloutSource(() => [rec]), { now: () => NOW + 1 * H }).poll();
    expect(snaps.find((s) => s.window === '5h')?.usedPct).toBe(50);
  });

  it('выбирается самая свежая запись основной корзины, даже если она не последняя в потоке строк', () => {
    const old = rl(NOW - 3 * H, 'codex', [20, NOW], [60, NOW + 5 * 24 * H]);
    const fresh = rl(NOW, 'codex', [50, NOW + 2 * H], [70, NOW + 5 * 24 * H]);
    // два параллельных сеанса: свежая запись лежит в более раннем файле
    expect(latestRateLimits([fresh, old])?.primary?.usedPct).toBe(50);
    expect(latestRateLimits([old, fresh])?.primary?.usedPct).toBe(50);
  });

  it('основная корзина важнее чужой: premium с окнами не подменяет codex', () => {
    const main = rl(NOW - 6 * H, 'codex', [40, NOW], [90, NOW + 5 * 24 * H]);
    const other = rl(NOW, 'premium', [5, NOW + 4 * H], [5, NOW + 6 * 24 * H]);
    expect(latestRateLimits([main, other])?.limitId).toBe('codex');
    // если основной корзины нет вовсе, берётся то, что есть
    expect(latestRateLimits([other])?.limitId).toBe('premium');
    // старые логи без limit_id считаются основной корзиной
    expect(latestRateLimits([rl(NOW, null, [1, NOW + H], null)])?.primary?.usedPct).toBe(1);
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
