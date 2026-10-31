import { evaluateBudget, type BudgetSettings, type BudgetState } from './budget.js';
import { DAY, HOUR, MINUTE, median, nextDayStartMs, toZoned, dayStartMs } from './time.js';
import { weightedHours } from './schedule.js';
import { estimateK, kSamples, windowDelta, type KEstimate, type KSample } from './ticks.js';
import type { AppMode, Tick } from './types.js';

export interface DaySeriesRow {
  date: string;
  start: number;
  /** Взвешенные часы расписания, которые уже прошли к концу интервала расчёта. */
  workHours: number;
  gain5h: number;
  gain7d: number;
}

/** Суточные суммы прироста и рабочих часов по расписанию. Сутки — в поясе расписания. */
export function dailySeries(ticks: Tick[], tz: string, schedule: BudgetSettings['schedule'], from: number, to: number): DaySeriesRow[] {
  const rows = new Map<string, DaySeriesRow>();
  const ensure = (ms: number) => {
    const date = toZoned(ms, tz).dateKey;
    let r = rows.get(date);
    if (!r) {
      const start = dayStartMs(ms, tz);
      const end = Math.min(nextDayStartMs(ms, tz), to);
      r = { date, start, workHours: weightedHours(schedule, Math.max(start, from), Math.max(start, end)), gain5h: 0, gain7d: 0 };
      rows.set(date, r);
    }
    return r;
  };
  // Дни без роста тоже нужны: они определяют знаменатель для скорости.
  for (let t = dayStartMs(from, tz); t < to; t = nextDayStartMs(t, tz)) ensure(Math.max(t, from));
  for (let i = 1; i < ticks.length; i++) {
    const p = ticks[i - 1];
    const t = ticks[i];
    if (t.ts < from || t.ts > to) continue;
    const r = ensure(t.ts);
    r.gain5h += windowDelta(p.u5h, t.u5h, p.r5h, t.r5h).delta;
    r.gain7d += windowDelta(p.u7d, t.u7d, p.r7d, t.r7d).delta;
  }
  return [...rows.values()].sort((a, b) => a.start - b.start);
}

/** Медианная скорость расхода недели за последние `days` рабочих дней, п.п. за рабочий час. */
export function speed7d(ticks: Tick[], settings: BudgetSettings, now: number, days = 14): number | null {
  const from = now - 60 * DAY;
  const series = dailySeries(ticks, settings.schedule.tz, settings.schedule, from, now)
    .filter((r) => r.workHours >= 1)
    .slice(-days);
  return median(series.map((r) => r.gain7d / r.workHours).filter((v) => Number.isFinite(v)));
}

/** Скорость роста 5-часового процента за последние lookback минут, п.п. в час. */
export function rate5hAt(ticks: Tick[], index: number, lookbackMs = 15 * MINUTE): number | null {
  const cur = ticks[index];
  if (cur.u5h === null) return null;
  let j = index;
  while (j > 0 && cur.ts - ticks[j - 1].ts <= lookbackMs) j--;
  if (j === index) return null;
  let gain = 0;
  for (let i = j + 1; i <= index; i++) {
    gain += windowDelta(ticks[i - 1].u5h, ticks[i].u5h, ticks[i - 1].r5h, ticks[i].r5h).delta;
  }
  const hours = (cur.ts - ticks[j].ts) / HOUR;
  return hours > 0 ? gain / hours : null;
}

export interface ReplayOptions {
  settings: BudgetSettings;
  mode?: AppMode | ((ts: number) => AppMode);
  /** Фиксированная оценка k; иначе k считается скользящим окном по данным до текущего тика. */
  fixedK?: KEstimate | null;
  /** Считать скорость расхода для H_left (дороже по времени). */
  withSpeed?: boolean;
}

export interface ReplayPoint {
  ts: number;
  tick: Tick;
  state: BudgetState;
}

/** Прогоняет сохранённую историю тиков через калькулятор, как если бы виджет работал всё это время. */
export function replay(ticks: Tick[], opts: ReplayOptions): ReplayPoint[] {
  const out: ReplayPoint[] = [];
  const samples: KSample[] = opts.fixedK ? [] : kSamples(ticks, opts.settings.peak);
  let sampleIdx = 0;
  let estimate: KEstimate | null = opts.fixedK ?? null;
  let speed: number | null = null;
  let speedDay = '';
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (!opts.fixedK) {
      let changed = false;
      while (sampleIdx < samples.length && samples[sampleIdx].ts <= t.ts) {
        sampleIdx++;
        changed = true;
      }
      if (changed || estimate === null) {
        estimate = estimateK(samples.slice(0, sampleIdx), { now: t.ts });
      }
    }
    if (opts.withSpeed) {
      const day = toZoned(t.ts, opts.settings.schedule.tz).dateKey;
      if (day !== speedDay) {
        speed = speed7d(ticks.slice(0, i + 1), opts.settings, t.ts);
        speedDay = day;
      }
    }
    const mode = typeof opts.mode === 'function' ? opts.mode(t.ts) : (opts.mode ?? 'work');
    const state = evaluateBudget(
      {
        now: t.ts,
        mode,
        u5h: t.u5h,
        r5h: t.r5h,
        u7d: t.u7d,
        r7d: t.r7d,
        k: estimate,
        rate5h: rate5hAt(ticks, i),
        speed7d: speed,
      },
      opts.settings,
    );
    out.push({ ts: t.ts, tick: t, state });
  }
  return out;
}
