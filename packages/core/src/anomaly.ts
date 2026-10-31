import { attribute, UNKNOWN_MODEL, type ContextSegment } from './attribution.js';
import type { BudgetSettings } from './budget.js';
import { growthIntervals } from './ticks.js';
import { splitByHour } from './stats.js';
import { DAY, MINUTE, mad, median, toZoned } from './time.js';
import type { Anomaly, GrowthInterval, ProviderId, Tick } from './types.js';

export interface DetectorOptions {
  /** Сколько предыдущих дней служит базой для сравнения. */
  baselineDays?: number;
  /** Минимум значений в базе, иначе детектор молчит. */
  minBaseline?: number;
  /** Во сколько робастных отклонений значение должно превышать медиану. */
  madK?: number;
  /** Сколько последних дней должен держаться сдвиг. */
  persistDays?: number;
  /** Параметры CUSUM в долях σ. */
  cusumSlack?: number;
  cusumThreshold?: number;
  /** Минимум минут работы за час / за день, чтобы значение попало в ряд. */
  minHourMinutes?: number;
  minDayMinutes?: number;
  /** Рост недельного показателя больше этой доли считается ростом. */
  weeklyGrowthTolerance?: number;
  /** Минимальный сдвиг уровня (доля от базы) для сигнала по дневному ряду: мелкие колебания меняют не лимит, а шум. */
  minRelativeShift?: number;
  /** Разметка модели и режима: тогда сдвиг ищется и внутри той же модели и режима. */
  timeline?: ContextSegment[];
}

const DEFAULTS = {
  baselineDays: 14,
  minBaseline: 5,
  madK: 3,
  persistDays: 3,
  cusumSlack: 0.5,
  cusumThreshold: 4,
  minHourMinutes: 10,
  minDayMinutes: 30,
  weeklyGrowthTolerance: 0.25,
  minRelativeShift: 0.2,
};

const SIGMA_FLOOR = 0.1; // не меньше 10% от медианы: целочисленные проценты шумят и без изменения лимитов
const MAD_TO_SIGMA = 1.4826;

function robustSigma(values: number[], med: number): number {
  const m = mad(values, med) ?? 0;
  return Math.max(MAD_TO_SIGMA * m, SIGMA_FLOOR * Math.abs(med), 1e-9);
}

interface DayAgg {
  date: string;
  minutes: number;
  d5h: number;
  d7d: number;
}

interface HourAgg extends DayAgg {
  hour: number;
}

function perHour(v: number, minutes: number): number {
  return v / (minutes / 60);
}

/** CUSUM вверх по ряду значений: true, если сдвиг уровня вверх накопился и держится в последних днях. */
export function cusumUp(
  series: number[],
  o: Required<Pick<DetectorOptions, 'minBaseline' | 'persistDays' | 'cusumSlack' | 'cusumThreshold'>> & { minRelativeShift?: number },
): { shifted: boolean; ratio: number } {
  const need = o.minBaseline + o.persistDays;
  if (series.length < need) return { shifted: false, ratio: 1 };
  const b = Math.max(o.minBaseline, Math.min(7, Math.floor(series.length / 2)));
  const base = series.slice(0, b);
  const mu = median(base)!;
  if (mu <= 0) return { shifted: false, ratio: 1 };
  const sigma = robustSigma(base, mu);
  let s = 0;
  for (let i = b; i < series.length; i++) s = Math.max(0, s + (series[i] - mu - o.cusumSlack * sigma));
  const recent = median(series.slice(-o.persistDays))!;
  const holds = recent > mu + sigma && recent / mu >= 1 + (o.minRelativeShift ?? DEFAULTS.minRelativeShift);
  return { shifted: s > o.cusumThreshold * sigma && holds, ratio: recent / mu };
}

export interface DetectInput {
  provider: ProviderId;
  ticks: Tick[];
  settings: BudgetSettings;
  now: number;
  options?: DetectorOptions;
}

/**
 * Три сигнала «возможного изменения лимитов» (без токенов нельзя отличить тяжёлые запросы от смены лимита,
 * поэтому это всегда «возможное», а не «подтверждённое»):
 *  - peak: 5-часовой процент на час работы в часовой корзине стабильно выше медианы последних 14 дней по MAD,
 *    недельный не вырос — «тяжёлый час», k в нём падает (так проявилась бы пиковая настройка);
 *  - drop: недельный процент на час работы вырос, и сдвиг держится по дневным значениям (CUSUM) — возможное уменьшение недельного лимита;
 *  - step: 5-часовой процент на час работы сдвинулся вверх по дневным значениям, а недельный нет.
 */
export function detectAnomalies(input: DetectInput): Anomaly[] {
  const o = { ...DEFAULTS, ...input.options };
  const tz = input.settings.schedule.tz;
  const intervals = growthIntervals(input.ticks);
  if (!intervals.length) return [];

  // --- Часовые корзины по дням (для тяжёлых часов).
  const hours = new Map<string, HourAgg>();
  for (const iv of intervals) {
    for (const s of splitByHour(iv, tz)) {
      const date = toZoned(iv.start + (iv.end - iv.start) * 0.5, tz).dateKey;
      const key = `${date}|${s.hour}`;
      let h = hours.get(key);
      if (!h) {
        h = { date, hour: s.hour, minutes: 0, d5h: 0, d7d: 0 };
        hours.set(key, h);
      }
      h.minutes += s.ms / MINUTE;
      h.d5h += iv.d5h * s.share;
      h.d7d += iv.d7d * s.share;
    }
  }
  const out: Anomaly[] = [];
  const horizonFrom = input.now - (o.baselineDays + o.persistDays + 4) * DAY;

  for (let hour = 0; hour < 24; hour++) {
    const rows = [...hours.values()]
      .filter((h) => h.hour === hour && h.minutes >= o.minHourMinutes && h.date >= toZoned(horizonFrom, tz).dateKey)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (rows.length < o.minBaseline + o.persistDays) continue;
    const recent = rows.slice(-o.persistDays);
    const base = rows.slice(0, -o.persistDays);
    if (base.length < o.minBaseline) continue;
    const base5 = base.map((r) => perHour(r.d5h, r.minutes));
    const med5 = median(base5)!;
    if (med5 <= 0) continue;
    const sigma5 = robustSigma(base5, med5);
    const heavy = recent.every((r) => perHour(r.d5h, r.minutes) > med5 + o.madK * sigma5);
    if (!heavy) continue;
    const base7 = base.map((r) => perHour(r.d7d, r.minutes));
    const med7 = median(base7) ?? 0;
    const recent7 = median(recent.map((r) => perHour(r.d7d, r.minutes))) ?? 0;
    const weeklyGrew = med7 > 0 ? recent7 > med7 * (1 + o.weeklyGrowthTolerance) + o.madK * robustSigma(base7, med7) : recent7 > 0.5;
    if (weeklyGrew) continue;
    const ratio = median(recent.map((r) => perHour(r.d5h, r.minutes)))! / med5;
    out.push({
      ts: input.now,
      provider: input.provider,
      window: '5h',
      kind: 'peak',
      ratio,
      note: `Тяжёлый час ${String(hour).padStart(2, '0')}:00: 5-часовой процент на час работы ×${ratio.toFixed(2)} к медиане, недельный не вырос`,
    });
  }

  // --- Дневные ряды: 5-часовой и недельный процент на час работы.
  const dayAgg = (ivs: GrowthInterval[]): DayAgg[] => {
    const days = new Map<string, DayAgg>();
    for (const iv of ivs) {
      const date = toZoned(iv.start + (iv.end - iv.start) * 0.5, tz).dateKey;
      let d = days.get(date);
      if (!d) {
        d = { date, minutes: 0, d5h: 0, d7d: 0 };
        days.set(date, d);
      }
      d.minutes += (iv.end - iv.start) / MINUTE;
      d.d5h += iv.d5h;
      d.d7d += iv.d7d;
    }
    return [...days.values()].filter((d) => d.minutes >= o.minDayMinutes).sort((a, b) => (a.date < b.date ? -1 : 1));
  };
  const cOpts = {
    minBaseline: o.minBaseline,
    persistDays: o.persistDays,
    cusumSlack: o.cusumSlack,
    cusumThreshold: o.cusumThreshold,
    minRelativeShift: o.minRelativeShift,
  };

  const groups: Array<{ label: string | null; days: DayAgg[] }> = [{ label: null, days: dayAgg(intervals) }];
  if (o.timeline?.length) {
    const byDate = new Map<string, GrowthInterval[]>();
    for (const iv of intervals) {
      const date = toZoned(iv.start + (iv.end - iv.start) * 0.5, tz).dateKey;
      byDate.set(date, [...(byDate.get(date) ?? []), iv]);
    }
    const perGroup = new Map<string, Map<string, DayAgg>>();
    for (const [date, ivs] of byDate) {
      for (const row of attribute(ivs, o.timeline)) {
        if (row.model === UNKNOWN_MODEL) continue;
        const label = `${row.model}${row.effort ? ` / ${row.effort}` : ''}`;
        const m = perGroup.get(label) ?? new Map<string, DayAgg>();
        m.set(date, { date, minutes: row.minutes, d5h: row.d5h, d7d: row.d7d });
        perGroup.set(label, m);
      }
    }
    for (const [label, m] of perGroup) {
      groups.push({
        label,
        days: [...m.values()].filter((d) => d.minutes >= o.minDayMinutes).sort((a, b) => (a.date < b.date ? -1 : 1)),
      });
    }
  }

  for (const g of groups) {
    const x5 = g.days.map((d) => perHour(d.d5h, d.minutes));
    const x7 = g.days.map((d) => perHour(d.d7d, d.minutes));
    const weekly = cusumUp(x7, cOpts);
    const five = cusumUp(x5, cOpts);
    const suffix = g.label ? ` (${g.label})` : '';
    if (weekly.shifted) {
      out.push({
        ts: input.now,
        provider: input.provider,
        window: '7d',
        kind: 'drop',
        ratio: weekly.ratio,
        note: `Возможное уменьшение недельного лимита${suffix}: недельный процент на час работы ×${weekly.ratio.toFixed(2)}`,
      });
    } else if (five.shifted) {
      out.push({
        ts: input.now,
        provider: input.provider,
        window: '5h',
        kind: 'step',
        ratio: five.ratio,
        note: `Возможное изменение 5-часового лимита${suffix}: процент на час работы ×${five.ratio.toFixed(2)}, недельный не вырос`,
      });
    }
  }
  return out;
}
