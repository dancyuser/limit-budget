import { describe, expect, it } from 'vitest';
import {
  MINUTE,
  UsageSimulator,
  defaultPeakProfile,
  defaultSchedule,
  estimateK,
  groupTicks,
  growthIntervals,
  kSamples,
  windowDelta,
  type Snapshot,
  type Tick,
} from '../src/index.js';
import { msk } from './helpers.js';

const t0 = msk('2026-11-03', '10:00');
const tick = (min: number, u5h: number, u7d: number, r5h: number | null = null, r7d: number | null = null): Tick => ({
  ts: t0 + min * MINUTE,
  u5h,
  r5h,
  u7d,
  r7d,
});

describe('склейка снимков в тики', () => {
  it('собирает окна и срезы по моделям на одном ts', () => {
    const snaps: Snapshot[] = [
      { ts: 1, provider: 'claude', window: '5h', bucket: 'all', usedPct: 10, resetsAt: 100, source: 't' },
      { ts: 1, provider: 'claude', window: '7d', bucket: 'all', usedPct: 30, resetsAt: 200, source: 't' },
      { ts: 1, provider: 'claude', window: '7d', bucket: 'sonnet', usedPct: 5, resetsAt: 200, source: 't' },
      { ts: 2, provider: 'claude', window: '7d', bucket: 'all', usedPct: 31, resetsAt: 200, source: 't' },
    ];
    const ticks = groupTicks(snaps);
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toMatchObject({ u5h: 10, r5h: 100, u7d: 30, r7d: 200, sonnet7d: 5 });
    expect(ticks[1].u5h).toBeNull();
  });
});

describe('прирост с учётом сброса окна', () => {
  it('рост и сброс', () => {
    expect(windowDelta(10, 14, 100, 100)).toEqual({ delta: 4, reset: false });
    expect(windowDelta(80, 3, 100, 100)).toEqual({ delta: 3, reset: true });
    expect(windowDelta(40, 45, 100, 100 + 5 * 60 * MINUTE)).toEqual({ delta: 45, reset: true });
    expect(windowDelta(null, 4, null, null).delta).toBe(0);
  });
});

describe('интервалы работы по росту процента', () => {
  it('подряд идущие снимки с ростом склеиваются, длинная пауза разрывает', () => {
    const ticks = [
      tick(0, 0, 0),
      tick(1, 1, 0),
      tick(2, 2, 0),
      tick(3, 2, 0),
      tick(4, 3, 1), // пауза в 1 минуту — склеено
      tick(5, 3, 1),
      tick(6, 3, 1),
      tick(7, 3, 1),
      tick(8, 3, 1),
      tick(9, 3, 1),
      tick(30, 6, 1), // долгая пауза — новый интервал
    ];
    const iv = growthIntervals(ticks);
    expect(iv).toHaveLength(2);
    expect(iv[0].d5h).toBe(3);
    expect(iv[0].d7d).toBe(1);
    expect(iv[0].start).toBe(t0);
    expect(iv[0].end).toBe(t0 + 4 * MINUTE);
    expect(iv[1].d5h).toBe(3);
  });

  it('сумма приростов интервалов равна общему приросту', () => {
    const ticks = [tick(0, 0, 0), tick(1, 2, 0), tick(2, 5, 1), tick(40, 9, 2), tick(41, 12, 2)];
    const iv = growthIntervals(ticks);
    expect(iv.reduce((s, i) => s + i.d5h, 0)).toBe(12);
    expect(iv.reduce((s, i) => s + i.d7d, 0)).toBe(2);
  });
});

describe('коэффициент k', () => {
  const sched = defaultSchedule();
  const peak = defaultPeakProfile();
  const week = msk('2026-09-14', '10:00');
  const sim = (seed: number) =>
    new UsageSimulator({ start: msk('2026-09-14', '00:00'), weekResetsAt: week, schedule: sched, peak, seed, kOffpeak: 0.15, kPeak: 0.1 });

  it('восстанавливает заложенные значения отдельно для пика и вне пика', () => {
    const ticks = sim(7).advance(msk('2026-10-12', '00:00')); // четыре недели без перехода на зимнее время
    const est = estimateK(kSamples(ticks, peak));
    expect(est.nOffpeak).toBeGreaterThan(20);
    expect(est.nPeak).toBeGreaterThan(20);
    expect(est.offpeak!).toBeGreaterThan(0.12);
    expect(est.offpeak!).toBeLessThan(0.18);
    expect(est.peak!).toBeGreaterThan(0.08);
    expect(est.peak!).toBeLessThan(0.12);
    expect(est.peak!).toBeLessThan(est.offpeak!);
  });

  it('до накопления данных возвращает null', () => {
    const est = estimateK([{ ts: 1, d5h: 2, d7d: 0.3, peak: false }]);
    expect(est.offpeak).toBeNull();
    expect(est.peak).toBeNull();
  });
});
