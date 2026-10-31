import { describe, expect, it } from 'vitest';
import {
  FakeProvider,
  MINUTE,
  SignalEngine,
  UsageSimulator,
  defaultPeakProfile,
  defaultSchedule,
  groupTicks,
  replay,
  tickToSnapshots,
} from '../src/index.js';
import { msk, settings } from './helpers.js';

const S = settings();

describe('режим реплея: сохранённая история через калькулятор', () => {
  it('неделя со сбросом в середине: цель и неделя перескакивают на новое окно', () => {
    const resets = msk('2026-11-04', '13:00'); // среда
    const sim = new UsageSimulator({
      start: msk('2026-11-02', '00:00'),
      weekResetsAt: resets,
      schedule: defaultSchedule(),
      peak: defaultPeakProfile(),
      seed: 3,
    });
    const ticks = sim.advance(msk('2026-11-06', '19:00'));
    const points = replay(ticks, { settings: S });
    const before = points.find((p) => p.ts === msk('2026-11-04', '12:00'))!;
    const after = points.find((p) => p.ts === msk('2026-11-04', '13:30'))!;
    expect(before.state.week.end).toBe(resets);
    expect(after.state.week.end).toBe(resets + 7 * 24 * 60 * MINUTE);
    expect(after.tick.u7d!).toBeLessThan(before.tick.u7d!);
    expect(after.state.target!).toBeLessThan(before.state.target!);
    expect(after.state.stale).toBe(false);
  }, 30_000);

  it('день отпуска: за весь день ни одного сигнала и нет целей', () => {
    const sim = new UsageSimulator({
      start: msk('2026-11-02', '00:00'),
      weekResetsAt: msk('2026-11-09', '10:00'),
      schedule: defaultSchedule(),
      peak: defaultPeakProfile(),
      seed: 5,
      ratePerActiveMinute: 1.2, // нарочито быстрый расход
    });
    const ticks = sim.advance(msk('2026-11-03', '23:00'));
    const points = replay(ticks, { settings: S, mode: 'vacation' });
    const engine = new SignalEngine();
    let events = 0;
    for (const p of points) events += engine.update({ now: p.ts, budget: p.state, r5h: p.tick.r5h }).length;
    expect(events).toBe(0);
    expect(points.every((p) => p.state.target === null && p.state.status === 'off')).toBe(true);
    expect(points.at(-1)!.tick.u7d!).toBeGreaterThan(0);
  }, 30_000);

  it('перерасход приводит к сигналам, и каждое условие звучит один раз без напоминаний', () => {
    const sim = new UsageSimulator({
      start: msk('2026-11-03', '00:00'),
      weekResetsAt: msk('2026-11-09', '10:00'),
      schedule: defaultSchedule(),
      peak: defaultPeakProfile(),
      seed: 9,
      ratePerActiveMinute: 1.5,
      activeShare: 0.9,
    });
    const ticks = sim.advance(msk('2026-11-03', '14:00'));
    const points = replay(ticks, { settings: S });
    const cfg = { enabled: { ...new SignalEngine().config.enabled }, reminderMinutes: 0, rearmMinutes: 5 };
    const engine = new SignalEngine(cfg);
    const kinds: string[] = [];
    for (const p of points) {
      for (const ev of engine.update({ now: p.ts, budget: p.state, r5h: p.tick.r5h })) kinds.push(ev.kind);
    }
    expect(kinds).toContain('over-trajectory');
    expect(kinds.filter((k) => k === 'over-trajectory').length).toBeLessThanOrEqual(2);
  }, 30_000);
});

describe('FakeProvider и контракт провайдера', () => {
  it('провайдер без 5-часового окна отдаёт только недельное, ядро считает траекторию', async () => {
    const provider = new FakeProvider(
      () => [{ window: '7d', bucket: 'all', usedPct: 12, resetsAt: new Date(msk('2026-11-09', '10:00')) }],
      { id: 'chatgpt', capabilities: { windows: ['7d'], surfaces: ['codex_local', 'codex_cloud'], modelBreakdown: true, effort: true } },
    );
    const snaps = await provider.poll();
    expect(snaps).toHaveLength(1);
    const ticks = groupTicks(
      snaps.map((s) => ({
        ts: msk('2026-11-03', '12:00'),
        provider: provider.id,
        window: s.window,
        bucket: s.bucket,
        usedPct: s.usedPct,
        resetsAt: s.resetsAt?.getTime() ?? null,
        source: 'fake',
      })),
    );
    const [pt] = replay(ticks, { settings: S });
    expect(pt.state.available).toBeNull();
    expect(pt.state.target).not.toBeNull();
    expect(provider.capabilities.windows).toEqual(['7d']);
  });

  it('simulated-провайдер продвигает время и отдаёт оба окна', async () => {
    let now = msk('2026-11-03', '10:00');
    const sim = new UsageSimulator({
      start: now,
      weekResetsAt: msk('2026-11-09', '10:00'),
      schedule: defaultSchedule(),
      peak: defaultPeakProfile(),
      seed: 1,
    });
    const provider = FakeProvider.simulated(sim, () => now);
    now += 30 * MINUTE;
    const snaps = await provider.poll();
    expect(snaps.map((s) => s.window).sort()).toEqual(['5h', '7d']);
    expect(tickToSnapshots(sim.snapshot())).toHaveLength(2);
  });
});
