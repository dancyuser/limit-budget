import { describe, expect, it } from 'vitest';
import { MINUTE, addDays, computeStats, periodRange, weekdayOf, type ModelSample, type PeriodKind, type PeriodMode, type Tick } from '../src/index.js';
import { msk, settings } from './helpers.js';

const S = settings();
const NOW = msk('2026-11-18', '18:00'); // среда
const R7_FAR = msk('2026-12-07', '10:00');

/**
 * Синтетическая история, которую легко проверить вручную. В каждый будний день, начиная с 12 октября:
 *   11:00–11:05  всплеск A (вне пика): +10 п.п. 5-часового, +1,5 п.п. недельного
 *   17:00–17:03  всплеск B (пиковое время): +6 п.п. 5-часового, +0,6 п.п. недельного
 * Итого за рабочий день: 16 и 2,1.
 */
function buildTicks(): Tick[] {
  const ticks: Tick[] = [];
  let u7 = 0;
  let date = '2026-10-12';
  while (date <= '2026-11-18') {
    const wd = weekdayOf(date);
    ticks.push({ ts: msk(date, '00:00'), u5h: 0, r5h: null, u7d: u7, r7d: R7_FAR });
    if (wd <= 5) {
      const burst = (hm: string, steps: number, d5: number, d7: number, r5h: number) => {
        const t0 = msk(date, hm);
        for (let i = 0; i <= steps; i++) {
          ticks.push({ ts: t0 + i * MINUTE, u5h: i * d5, r5h: i === 0 ? null : r5h, u7d: u7 + i * d7, r7d: R7_FAR });
        }
        u7 += steps * d7;
        // окно закончилось, пока пользователь не работал
        ticks.push({ ts: t0 + (steps + 10) * MINUTE, u5h: 0, r5h: null, u7d: u7, r7d: R7_FAR });
      };
      burst('11:00', 5, 2, 0.3, msk(date, '16:00'));
      burst('17:00', 3, 2, 0.2, msk(date, '22:00'));
    }
    date = addDays(date, 1);
  }
  return ticks.filter((t) => t.ts <= NOW).sort((a, b) => a.ts - b.ts);
}

const TICKS = buildTicks();
const stats = (kind: PeriodKind, mode: PeriodMode, extra: { samples?: ModelSample[] } = {}) =>
  computeStats({ ticks: TICKS, tasks: [], samples: extra.samples ?? [], settings: S, kind, mode, now: NOW });

// Ручной подсчёт числа рабочих дней со всплесками в периоде (дни, чьи всплески попали в [from, now]).
const EXPECTED: Record<PeriodMode, Record<PeriodKind, number>> = {
  calendar: { day: 1, week: 3, '2weeks': 8, month: 13 },
  rolling: { day: 1, week: 5, '2weeks': 10, month: 22 },
};

describe('границы периодов', () => {
  it('календарные: сегодня, с понедельника, с понедельника прошлой недели, с 1-го числа', () => {
    expect(periodRange('day', 'calendar', NOW, 'UTC+3').from).toBe(msk('2026-11-18', '00:00'));
    expect(periodRange('week', 'calendar', NOW, 'UTC+3').from).toBe(msk('2026-11-16', '00:00'));
    expect(periodRange('2weeks', 'calendar', NOW, 'UTC+3').from).toBe(msk('2026-11-09', '00:00'));
    expect(periodRange('month', 'calendar', NOW, 'UTC+3').from).toBe(msk('2026-11-01', '00:00'));
  });

  it('скользящие: 1, 7, 14 и 30 суток назад', () => {
    const day = 24 * 60 * MINUTE;
    expect(periodRange('day', 'rolling', NOW, 'UTC+3').from).toBe(NOW - day);
    expect(periodRange('week', 'rolling', NOW, 'UTC+3').from).toBe(NOW - 7 * day);
    expect(periodRange('2weeks', 'rolling', NOW, 'UTC+3').from).toBe(NOW - 14 * day);
    expect(periodRange('month', 'rolling', NOW, 'UTC+3').from).toBe(NOW - 30 * day);
  });
});

describe('статистика за день, неделю, две недели и месяц совпадает с ручной проверкой по снимкам', () => {
  for (const mode of ['calendar', 'rolling'] as PeriodMode[]) {
    for (const kind of ['day', 'week', '2weeks', 'month'] as PeriodKind[]) {
      it(`${mode} / ${kind}`, () => {
        const n = EXPECTED[mode][kind];
        const s = stats(kind, mode);
        expect(s.totals.gain5h).toBeCloseTo(16 * n, 6);
        expect(s.totals.gain7d).toBeCloseTo(2.1 * n, 6);
        expect(s.totals.peak5h).toBe(10);
        expect(s.totals.windows).toBe(2 * n);
        // время работы по росту процента: 5 + 3 минуты на день
        expect(s.totals.workMinutes).toBeCloseTo(8 * n, 6);
        // сумма по дням равна итогу
        expect(s.days.reduce((a, d) => a + d.gain5h, 0)).toBeCloseTo(s.totals.gain5h, 6);
        expect(s.days.reduce((a, d) => a + d.gain7d, 0)).toBeCloseTo(s.totals.gain7d, 6);
      });
    }
  }
});

describe('пиковые и непиковые часы отдельно', () => {
  it('всплеск B попадает в пик, всплеск A — нет', () => {
    const s = stats('week', 'calendar');
    expect(s.peakSplit.peak.d5h).toBeCloseTo(6 * 3, 6);
    expect(s.peakSplit.offpeak.d5h).toBeCloseTo(10 * 3, 6);
    expect(s.peakSplit.peak.d7d).toBeCloseTo(0.6 * 3, 6);
    expect(s.peakSplit.offpeak.d7d).toBeCloseTo(1.5 * 3, 6);
    // 3 минуты пикового труда в день × 3 дня
    expect(s.peakSplit.peak.hours).toBeCloseTo((3 * 3) / 60, 6);
  });
});

describe('время работы и проценты по модели и режиму', () => {
  it('без разметки всё в unknown и помечено как оценка', () => {
    const s = stats('week', 'calendar');
    expect(s.models).toHaveLength(1);
    expect(s.models[0].model).toBe('unknown');
    expect(s.models[0].estimated).toBe(true);
    expect(s.models[0].d7d).toBeCloseTo(s.totals.gain7d, 6);
  });

  it('сумма по моделям равна общему приросту', () => {
    const samples: ModelSample[] = ['2026-11-16', '2026-11-17', '2026-11-18'].flatMap((d) => [
      { ts: msk(d, '10:30'), provider: 'claude' as const, surface: 'chat', model: 'opus', effort: 'extended', source: 'manual' },
      { ts: msk(d, '11:03'), provider: 'claude' as const, surface: 'chat', model: 'sonnet', effort: null, source: 'manual' },
      { ts: msk(d, '12:00'), provider: 'claude' as const, surface: 'chat', model: 'opus', effort: null, source: 'manual' },
    ]);
    const s = stats('week', 'calendar', { samples });
    expect(s.models.reduce((a, r) => a + r.d7d, 0)).toBeCloseTo(s.totals.gain7d, 6);
    expect(s.models.reduce((a, r) => a + r.d5h, 0)).toBeCloseTo(s.totals.gain5h, 6);
    const ext = s.models.find((r) => r.model === 'opus' && r.effort === 'extended')!;
    expect(ext.d5h).toBeGreaterThan(0);
    expect(ext.pct7dPerHour).not.toBeNull();
  });
});

describe('блоки, тепловая карта и остаток времени', () => {
  it('отчёт по блокам содержит X(t) и отклонение на начало и конец', () => {
    const s = stats('day', 'calendar');
    expect(s.blocks.length).toBeGreaterThanOrEqual(2);
    const morning = s.blocks.find((b) => b.index === 0)!;
    expect(morning.availableStart).not.toBeNull();
    expect(morning.deviationEnd).not.toBeNull();
    expect(morning.gain5h).toBeCloseTo(10, 6);
  });

  it('тепловая карта: вторник 11:00 содержит всплеск A', () => {
    const s = stats('month', 'calendar');
    const cell = s.heatmap.find((c) => c.weekday === 2 && c.hour === 11)!;
    expect(cell).toBeDefined();
    expect(cell.d5h).toBeGreaterThan(0);
    expect(s.heatmap.every((c) => c.hour >= 0 && c.hour < 24)).toBe(true);
  });

  it('остаток времени считается из скорости расхода за последние рабочие дни', () => {
    const s = stats('week', 'calendar');
    expect(s.timeLeft.speed7d).not.toBeNull();
    expect(s.timeLeft.speed7d!).toBeGreaterThan(0);
    expect(s.timeLeft.hoursLeft).not.toBeNull();
  });
});
