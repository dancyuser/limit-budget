import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakeProvider,
  MINUTE,
  UsageSimulator,
  defaultPeakProfile,
  defaultSchedule,
  parseHm,
  zonedToMs,
  type SignalEvent,
  type UsageProvider,
} from '@limit-budget/core';
import { Store } from '../src/shared/db.js';
import { AuthRequiredError, NetworkError, PollTimeoutError, ShapeError } from '../src/shared/errors.js';
import { UsageService } from '../src/shared/service.js';
import { ChatGptProvider, StaticRolloutSource } from '../src/providers/chatgpt.js';
import { codexRolloutFixture } from '../src/providers/fixtures.js';

const msk = (date: string, hm: string) => zonedToMs(date, parseHm(hm), 'UTC+3');
const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function setup(opts: { start: string; resets?: string; sim?: Partial<ConstructorParameters<typeof UsageSimulator>[0]>; file?: string } = { start: '' }) {
  const clock = { now: msk(opts.start, '09:59') };
  const sim = new UsageSimulator({
    start: clock.now,
    weekResetsAt: msk(opts.resets ?? '2026-11-09', '10:00'),
    schedule: defaultSchedule(),
    peak: defaultPeakProfile(),
    seed: 4,
    ...opts.sim,
  });
  const store = new Store(opts.file ?? ':memory:');
  cleanup.push(() => store.close());
  const provider = FakeProvider.simulated(sim, () => clock.now);
  const service = new UsageService({ store, providers: [provider], clock: () => clock.now });
  return { clock, sim, store, provider, service };
}

async function run(ctx: ReturnType<typeof setup>, minutes: number, onStep?: () => void) {
  for (let i = 0; i < minutes; i++) {
    ctx.clock.now += MINUTE;
    await ctx.service.pollOnce();
    onStep?.();
  }
}

describe('сервис опроса', () => {
  it('пишет снимки раз в опрос, считает интервалы роста и бюджет', async () => {
    const ctx = setup({ start: '2026-11-03' });
    await run(ctx, 120);
    const ticks = ctx.store.getTicks('claude');
    expect(ticks).toHaveLength(120);
    const view = ctx.service.getViewState().providers[0];
    expect(view.status).toBe('ok');
    expect(view.tick?.u7d).toBeGreaterThan(0);
    expect(view.budget?.available).not.toBeNull();
    expect(view.budget?.target).not.toBeNull();
    const intervals = ctx.store.getIntervals('claude', 0, ctx.clock.now);
    expect(intervals.length).toBeGreaterThan(0);
    // сумма приростов интервалов совпадает с общим приростом на отрезке
    const total5 = intervals.reduce((s, i) => s + i.d5h, 0);
    expect(total5).toBeGreaterThan(0);
    expect(total5).toBeLessThanOrEqual(120);
  }, 30_000);

  it('сигнал превышения подаётся один раз за пересечение порога, звуки идут в любое время', async () => {
    const ctx = setup({ start: '2026-11-03', sim: { ratePerActiveMinute: 1.5, activeShare: 0.9 } });
    const events: SignalEvent[] = [];
    ctx.service.on('signal', (s) => events.push(s.event));
    ctx.service.updateSettings({ signals: { reminderMinutes: 0 } });
    await run(ctx, 4 * 60);
    const exceeded = events.filter((e) => e.kind === 'limit-exceeded');
    const warn = events.filter((e) => e.kind === 'over-trajectory');
    expect(exceeded.length).toBe(1);
    expect(exceeded[0].severity).toBe('exceeded');
    expect(warn.length).toBe(1);
    expect(warn[0].severity).toBe('warning');
    // обеденный перерыв: сигнал подаётся, даже когда блок закончился
    expect(events.every((e) => e.reminder === false)).toBe(true);
  }, 60_000);

  it('режим «Отпуск» выключает все сигналы, шкалы остаются', async () => {
    const ctx = setup({ start: '2026-11-03', sim: { ratePerActiveMinute: 1.5, activeShare: 0.9 } });
    const events: SignalEvent[] = [];
    ctx.service.on('signal', (s) => events.push(s.event));
    ctx.service.setMode('vacation');
    await run(ctx, 3 * 60);
    expect(events).toEqual([]);
    const view = ctx.service.getViewState();
    expect(view.mode).toBe('vacation');
    expect(view.providers[0].budget?.target).toBeNull();
    expect(view.providers[0].tick?.u7d).toBeGreaterThan(0);
    expect(ctx.store.vacationRanges()).toEqual([{ from: expect.any(Number), to: null }]);
  }, 60_000);

  it('сбой опроса не подаёт ложных сигналов: показывается последнее значение с пометкой «устарело»', async () => {
    let fail = false;
    const clock = { now: msk('2026-11-03', '10:00') };
    const inner = new FakeProvider(() => [
      { window: '5h', bucket: 'all', usedPct: 90, resetsAt: new Date(clock.now + 3 * 3_600_000) },
      { window: '7d', bucket: 'all', usedPct: 80, resetsAt: new Date(msk('2026-11-09', '10:00')) },
    ]);
    const provider: UsageProvider = {
      id: 'claude',
      capabilities: inner.capabilities,
      poll: async () => {
        if (fail) throw new Error('claude.ai ответил 500');
        return inner.poll();
      },
    };
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const service = new UsageService({ store, providers: [provider], clock: () => clock.now });
    const events: SignalEvent[] = [];
    service.on('signal', (s) => events.push(s.event));
    await service.pollOnce();
    const before = events.length;
    expect(before).toBeGreaterThan(0); // 80% недели в первый день — реальное превышение
    fail = true;
    clock.now += 20 * MINUTE;
    await service.pollOnce();
    const view = service.getViewState().providers[0];
    expect(view.status).toBe('stale');
    expect(view.tick?.u7d).toBe(80);
    expect(view.error).toContain('500');
    expect(events.length).toBe(before);
  });

  it('зависший источник не блокирует опрос: через таймаут он помечается ошибкой, остальные работают', async () => {
    const clock = { now: msk('2026-11-03', '10:00') };
    const hung: UsageProvider = {
      id: 'claude',
      capabilities: { windows: ['5h', '7d'], surfaces: ['chat'], modelBreakdown: false, effort: false },
      poll: () => new Promise(() => {}),
    };
    const ok = new FakeProvider(() => [{ window: '7d', bucket: 'all', usedPct: 5, resetsAt: new Date(msk('2026-11-09', '10:00')) }], { id: 'chatgpt' });
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const service = new UsageService({ store, providers: [hung, ok], clock: () => clock.now, pollTimeoutMs: 40 });
    service.updateSettings({ providers: { chatgpt: { enabled: true } } });
    await service.pollOnce();
    const views = service.getViewState().providers;
    expect(views.find((p) => p.id === 'claude')?.error).toMatch(/не ответил/);
    expect(views.find((p) => p.id === 'chatgpt')?.tick?.u7d).toBe(5);
  });

  it('потеря входа помечается как «нужен вход»', async () => {
    const clock = { now: msk('2026-11-03', '10:00') };
    const provider: UsageProvider = {
      id: 'claude',
      capabilities: { windows: ['5h', '7d'], surfaces: ['chat'], modelBreakdown: false, effort: false },
      poll: async () => {
        throw new AuthRequiredError();
      },
    };
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const service = new UsageService({ store, providers: [provider], clock: () => clock.now });
    await service.pollOnce();
    expect(service.getViewState().providers[0].status).toBe('needs-login');
  });

  it('состояние переживает перезапуск: тики, режим и расписание читаются из базы', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lb-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'usage.sqlite');
    const first = setup({ start: '2026-11-03', file });
    await run(first, 30);
    first.service.setMode('vacation');
    first.service.setSchedule({ ...first.service.schedule, exceptions: [{ date: '2026-11-04', type: 'off' }] });
    first.store.close();
    cleanup.pop();

    const store = new Store(file);
    cleanup.push(() => store.close());
    const service = new UsageService({ store, providers: [new FakeProvider(() => [])], clock: () => first.clock.now });
    expect(service.mode).toBe('vacation');
    expect(service.schedule.exceptions).toEqual([{ date: '2026-11-04', type: 'off' }]);
    expect(service.getViewState().providers[0].tick).not.toBeNull();
  }, 30_000);

  it('ручная отметка модели и задача попадают в статистику по моделям', async () => {
    const ctx = setup({ start: '2026-11-03' });
    ctx.service.setModel('claude', 'opus', 'extended');
    ctx.service.startTask('claude');
    await run(ctx, 90);
    ctx.service.stopTask('claude');
    const stats = ctx.service.getStats('claude', 'day', 'calendar');
    const opus = stats.models.find((m) => m.model === 'opus' && m.effort === 'extended');
    expect(opus).toBeDefined();
    expect(opus!.taskMinutes).toBeCloseTo(90, 0);
    expect(opus!.d7d).toBeGreaterThan(0);
    expect(stats.models.reduce((s, m) => s + m.d7d, 0)).toBeCloseTo(stats.totals.gain7d, 6);
  }, 60_000);
});

describe('повторы после сбоя связи и обновление по требованию', () => {
  afterEach(() => vi.useRealTimers());

  /** Источник, который отвечает по сценарию: Error — сбой, null — нормальный ответ. Время каждого обращения запоминается. */
  function scripted(script: (n: number) => Error | null) {
    const calls: number[] = [];
    const inner = new FakeProvider(() => [
      { window: '5h', bucket: 'all', usedPct: 30, resetsAt: new Date(Date.now() + 3 * 3_600_000) },
      { window: '7d', bucket: 'all', usedPct: 20, resetsAt: new Date(msk('2026-11-09', '10:00')) },
    ]);
    const provider: UsageProvider = {
      id: 'claude',
      capabilities: inner.capabilities,
      poll: async () => {
        calls.push(Date.now());
        const err = script(calls.length);
        if (err) throw err;
        return inner.poll();
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(msk('2026-11-03', '10:30'));
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const failures: Array<[number, boolean]> = [];
    const service = new UsageService({ store, providers: [provider], onFailure: (_id, n, transient) => failures.push([n, transient]) });
    cleanup.push(() => service.stop());
    const gaps = () => calls.slice(1).map((t, i) => t - calls[i]);
    return { service, calls, gaps, failures, view: () => service.getViewState().providers[0] };
  }

  it('нет связи: повторы через 5, 10, 20 и 30 секунд, потом обычный интервал', async () => {
    const ctx = scripted(() => new NetworkError('Нет связи с claude.ai'));
    ctx.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.view().status).toBe('error');
    // следующая попытка известна интерфейсу: «повтор через 5 с»
    expect(ctx.view().retryAt! - Date.now()).toBe(5000);
    await vi.advanceTimersByTimeAsync(5000 + 10_000 + 20_000 + 30_000 + 60_000);
    const base = Math.max(10, ctx.service.settings.pollIntervalSec) * 1000;
    expect(ctx.gaps()).toEqual([5000, 10_000, 20_000, 30_000, base]);
    // каждый сбой сообщается приложению (оно сбросит соединения на втором)
    expect(ctx.failures.slice(0, 3)).toEqual([[1, true], [2, true], [3, true]]);
  });

  it('связь вернулась: ошибка уходит, интервал снова обычный', async () => {
    const ctx = scripted((n) => (n <= 2 ? new NetworkError('Нет связи с claude.ai') : null));
    ctx.service.start();
    await vi.advanceTimersByTimeAsync(5000 + 10_000);
    expect(ctx.calls).toHaveLength(3);
    const v = ctx.view();
    expect(v.status).toBe('ok');
    expect(v.error).toBeNull();
    expect(v.failures).toBe(0);
    expect(v.retryAt).toBeNull();
    await vi.advanceTimersByTimeAsync(Math.max(10, ctx.service.settings.pollIntervalSec) * 1000);
    expect(ctx.gaps().at(-1)).toBe(Math.max(10, ctx.service.settings.pollIntervalSec) * 1000);
  });

  it('таймаут источника тоже считается временным сбоем', async () => {
    const ctx = scripted((n) => (n === 1 ? new PollTimeoutError('источник не ответил за 30 с') : null));
    ctx.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.failures).toEqual([[1, true]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.calls).toHaveLength(2);
  });

  it('нужен вход или другая форма ответа: быстрые повторы не нужны, интервал обычный', async () => {
    for (const err of [new AuthRequiredError(), new ShapeError('форма не совпала')]) {
      const ctx = scripted(() => err);
      ctx.service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.view().retryAt).toBeNull();
      expect(ctx.failures).toEqual([[1, false]]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ctx.calls).toHaveLength(1);
      ctx.service.stop();
      vi.useRealTimers();
    }
  });

  it('«Обновить»: опрос идёт сразу, а не по таймеру; идущий опрос второй раз не запускается', async () => {
    const ctx = scripted(() => null);
    ctx.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await ctx.service.pollNow();
    expect(ctx.calls).toHaveLength(2);
    expect(ctx.calls[1] - ctx.calls[0]).toBe(15_000);
    // таймер перезапущен от момента обновления, лишнего опроса по старому таймеру нет
    const base = Math.max(10, ctx.service.settings.pollIntervalSec) * 1000;
    await vi.advanceTimersByTimeAsync(base - 1);
    expect(ctx.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.calls).toHaveLength(3);
    // два нажатия подряд дают один опрос
    const a = ctx.service.pollNow();
    const b = ctx.service.pollNow();
    await Promise.all([a, b]);
    expect(ctx.calls).toHaveLength(4);
  });

  it('без запущенного цикла (CLI, тесты) pollNow делает один круг опроса', async () => {
    const ctx = scripted(() => null);
    await ctx.service.pollNow();
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.view().status).toBe('ok');
  });
});

describe('задел под Codex: провайдер chatgpt на фикстурах', () => {
  it('включение флагом показывает карточку с данными из фикстур, не меняя базу и ядро', async () => {
    const clock = { now: msk('2026-11-03', '12:00') };
    const store = new Store(':memory:');
    cleanup.push(() => store.close());
    const claude = new FakeProvider(() => []);
    const codex = new ChatGptProvider(new StaticRolloutSource(() => codexRolloutFixture(clock.now)), { source: 'codex-fixture' });
    const service = new UsageService({ store, providers: [claude, codex], clock: () => clock.now });
    expect(service.getViewState().providers.find((p) => p.id === 'chatgpt')?.status).toBe('disabled');
    service.updateSettings({ providers: { chatgpt: { enabled: true } } });
    await service.pollOnce();
    const view = service.getViewState().providers.find((p) => p.id === 'chatgpt')!;
    expect(view.status).toBe('ok');
    expect(view.tick).toMatchObject({ u5h: 31, u7d: 29 });
    expect(view.budget?.available).not.toBeNull();
    expect(view.capabilities.surfaces).toEqual(['codex_local', 'codex_cloud']);
    // задачи из rollout сохранены с моделью и режимом
    const tasks = store.getTasks('chatgpt', 0, clock.now + MINUTE);
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.effort)).toEqual(['medium', 'high']);
    expect(tasks[0].source).toBe('rollout');
    // снимок записан в те же таблицы, что и у Claude
    expect(store.getSnapshots('chatgpt')[0].source).toBe('codex-fixture');
  });
});
