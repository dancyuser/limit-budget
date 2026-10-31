import { describe, expect, it } from 'vitest';
import {
  UsageSimulator,
  defaultPeakProfile,
  defaultSchedule,
  detectAnomalies,
  cusumUp,
  type SimOptions,
  type Tick,
} from '../src/index.js';
import { msk, settings } from './helpers.js';

const S = settings();
const START = msk('2026-09-07', '00:00'); // понедельник
const END = msk('2026-10-12', '00:00'); // пять недель, зимнее время США ещё не наступило

const simOpts = (over: Partial<SimOptions> = {}): SimOptions => ({
  start: START,
  weekResetsAt: msk('2026-09-14', '10:00'),
  schedule: defaultSchedule(),
  peak: defaultPeakProfile(),
  seed: 11,
  ...over,
});

const history = (over: Partial<SimOptions> = {}): Tick[] => new UsageSimulator(simOpts(over)).advance(END);
const detect = (ticks: Tick[], now = END) =>
  detectAnomalies({ provider: 'claude', ticks: ticks.filter((t) => t.ts <= now), settings: S, now });

describe('детектор изменений лимитов', () => {
  it('на спокойных неделях нет ложных тревог', () => {
    const ticks = history();
    for (const now of [msk('2026-09-25', '23:00'), msk('2026-10-02', '23:00'), END]) {
      expect(detect(ticks, now)).toEqual([]);
    }
  }, 60_000);

  it('искусственно сдвинутый недельный ряд обнаруживается как возможное уменьшение недельного лимита', () => {
    const ticks = history({ weeklyShift: { fromTs: msk('2026-10-01', '00:00'), factor: 1.6 } });
    const found = detect(ticks);
    const drop = found.find((a) => a.kind === 'drop');
    expect(drop).toBeDefined();
    expect(drop!.window).toBe('7d');
    expect(drop!.ratio).toBeGreaterThan(1.3);
  }, 60_000);

  it('тяжёлый час: 5-часовой процент вырос, недельный нет', () => {
    const ticks = history({ heavyHours: { fromTs: msk('2026-10-06', '00:00'), hours: [11], factor: 1.8 } });
    const found = detect(ticks);
    const peak = found.find((a) => a.kind === 'peak');
    expect(peak).toBeDefined();
    expect(peak!.note).toContain('11:00');
    expect(peak!.ratio).toBeGreaterThan(1.4);
    expect(found.some((a) => a.kind === 'drop')).toBe(false);
  }, 60_000);

  it('мало данных — детектор молчит', () => {
    const ticks = history().filter((t) => t.ts < msk('2026-09-11', '00:00'));
    expect(detect(ticks, msk('2026-09-11', '00:00'))).toEqual([]);
  }, 60_000);
});

describe('CUSUM', () => {
  const o = { minBaseline: 5, persistDays: 3, cusumSlack: 0.5, cusumThreshold: 4 };
  it('ровный ряд с шумом не срабатывает', () => {
    const series = [10, 10.8, 9.4, 10.3, 9.7, 10.5, 9.9, 10.2, 9.6, 10.4, 10.1, 9.8];
    expect(cusumUp(series, o).shifted).toBe(false);
  });
  it('держащийся сдвиг вверх срабатывает', () => {
    const series = [10, 10.8, 9.4, 10.3, 9.7, 10.5, 9.9, 14.2, 14.9, 14.1, 14.6, 14.4];
    const r = cusumUp(series, o);
    expect(r.shifted).toBe(true);
    expect(r.ratio).toBeGreaterThan(1.3);
  });
  it('небольшой устойчивый сдвиг (около 12%) — это шум, а не изменение лимита', () => {
    // CUSUM накопился (сдвиг держится 8 дней), но он около 14%: без порога по размеру сдвига это была бы ложная тревога
    const series = [10, 10.8, 9.4, 10.3, 9.7, 10.5, ...Array(8).fill(11.6)];
    expect(cusumUp(series, o).shifted).toBe(false);
    expect(cusumUp(series, { ...o, minRelativeShift: 0.05 }).shifted).toBe(true);
  });
  it('одиночный выброс не считается изменением', () => {
    const series = [10, 10.8, 9.4, 10.3, 9.7, 10.5, 9.9, 10.1, 10.2, 18, 10.3, 10.0];
    expect(cusumUp(series, o).shifted).toBe(false);
  });
});
