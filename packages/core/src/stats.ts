import { attribute, buildTimeline, taskTime, UNKNOWN_MODEL } from './attribution.js';
import type { BudgetSettings } from './budget.js';
import { isPeak } from './peak.js';
import { dailySeries, replay, speed7d as speed7dOf } from './replay.js';
import { activeIntervals } from './schedule.js';
import { estimateK, growthIntervals, kSamples, windowDelta } from './ticks.js';
import {
  DAY,
  HOUR,
  MINUTE,
  addDays,
  dayStartMs,
  nextDayStartMs,
  toZoned,
  weekStartMs,
  zonedToMs,
} from './time.js';
import type { GrowthInterval, ModelSample, TaskRecord, Tick } from './types.js';

export type PeriodKind = 'day' | 'week' | '2weeks' | 'month';
/** rolling — скользящее окно назад от «сейчас», calendar — календарный период. */
export type PeriodMode = 'rolling' | 'calendar';

export const PERIOD_LABELS: Record<PeriodKind, string> = {
  day: 'День',
  week: 'Неделя',
  '2weeks': 'Две недели',
  month: 'Месяц',
};

export function periodRange(kind: PeriodKind, mode: PeriodMode, now: number, tz: string): { from: number; to: number } {
  if (mode === 'rolling') {
    const days = { day: 1, week: 7, '2weeks': 14, month: 30 }[kind];
    return { from: now - days * DAY, to: now };
  }
  const z = toZoned(now, tz);
  switch (kind) {
    case 'day':
      return { from: dayStartMs(now, tz), to: now };
    case 'week':
      return { from: weekStartMs(now, tz), to: now };
    case '2weeks':
      return { from: zonedToMs(addDays(toZoned(weekStartMs(now, tz), tz).dateKey, -7), 0, tz), to: now };
    case 'month':
      return { from: zonedToMs(`${String(z.year).padStart(4, '0')}-${String(z.month).padStart(2, '0')}-01`, 0, tz), to: now };
  }
}

export interface VacationRange {
  from: number;
  to: number | null;
}

export interface StatsInput {
  ticks: Tick[];
  tasks: TaskRecord[];
  samples: ModelSample[];
  settings: BudgetSettings;
  kind: PeriodKind;
  mode: PeriodMode;
  now: number;
  vacations?: VacationRange[];
  /** Пауза, короче которой всплески роста склеиваются в один интервал работы. */
  pauseMs?: number;
}

export interface StatsDay {
  date: string;
  gain5h: number;
  gain7d: number;
  workHours: number;
  growthMinutes: number;
  vacation: boolean;
  /** Отклонение недельного процента от траектории T(t) на конец дня. */
  deviationEnd: number | null;
}

export interface BlockReport {
  date: string;
  index: number;
  start: number;
  end: number;
  availableStart: number | null;
  availableEnd: number | null;
  deviationStart: number | null;
  deviationEnd: number | null;
  gain5h: number;
  gain7d: number;
}

export interface ModelStatsRow {
  model: string;
  effort: string | null;
  surface: string | null;
  growthMinutes: number;
  taskMinutes: number;
  taskCount: number;
  d5h: number;
  d7d: number;
  /** п.п. за час работы: знаменатель — время задачи, если известно, иначе интервалы роста. */
  pct5hPerHour: number | null;
  pct7dPerHour: number | null;
  estimated: boolean;
}

export interface RegimeRow {
  hours: number;
  d5h: number;
  d7d: number;
  pct5hPerHour: number | null;
  pct7dPerHour: number | null;
  k: number | null;
  samples: number;
}

export interface HeatCell {
  weekday: number;
  hour: number;
  minutes: number;
  d5h: number;
  d7d: number;
  /** Недельный процент на час работы; null, если данных меньше порога. */
  pct7dPerHour: number | null;
  pct5hPerHour: number | null;
}

export interface UsageStats {
  kind: PeriodKind;
  mode: PeriodMode;
  from: number;
  to: number;
  totals: { gain5h: number; gain7d: number; peak5h: number; windows: number; workMinutes: number };
  days: StatsDay[];
  blocks: BlockReport[];
  models: ModelStatsRow[];
  peakSplit: { peak: RegimeRow; offpeak: RegimeRow };
  heatmap: HeatCell[];
  timeLeft: { speed7d: number | null; hoursLeft: number | null; remainingHours: number; notEnough: boolean };
}

/** Дробит интервал по границам локальных часов: нужно для тепловой карты «час × день недели». */
export function splitByHour(
  iv: GrowthInterval,
  tz: string,
): Array<{ weekday: number; hour: number; ms: number; share: number }> {
  const dur = iv.end - iv.start;
  const out: Array<{ weekday: number; hour: number; ms: number; share: number }> = [];
  if (dur <= 0) {
    const z = toZoned(iv.end, tz);
    return [{ weekday: z.weekday, hour: Math.floor(z.minutesOfDay / 60), ms: 0, share: 1 }];
  }
  let t = iv.start;
  while (t < iv.end) {
    const z = toZoned(t, tz);
    const hour = Math.floor(z.minutesOfDay / 60);
    const hourEnd = zonedToMs(z.dateKey, (hour + 1) * 60, tz);
    const next = Math.min(iv.end, hourEnd > t ? hourEnd : t + HOUR);
    out.push({ weekday: z.weekday, hour, ms: next - t, share: (next - t) / dur });
    t = next;
  }
  return out;
}

const perHour = (value: number, minutes: number): number | null => (minutes > 0 ? value / (minutes / 60) : null);

export function computeStats(input: StatsInput): UsageStats {
  const { settings, now } = input;
  const tz = settings.schedule.tz;
  const { from, to } = periodRange(input.kind, input.mode, now, tz);

  // Тики периода плюс один предыдущий — как база для первого прироста.
  let first = input.ticks.findIndex((t) => t.ts >= from);
  if (first === -1) first = input.ticks.length;
  const ticks = input.ticks.slice(Math.max(0, first - 1)).filter((t) => t.ts <= to);
  const inRange = ticks.filter((t) => t.ts >= from);

  // Суммарные приросты, пик 5-часового окна, число окон.
  let gain5h = 0;
  let gain7d = 0;
  let peak5h = 0;
  const windows = new Set<number>();
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (t.ts < from) continue;
    if (i > 0) {
      gain5h += windowDelta(ticks[i - 1].u5h, t.u5h, ticks[i - 1].r5h, t.r5h).delta;
      gain7d += windowDelta(ticks[i - 1].u7d, t.u7d, ticks[i - 1].r7d, t.r7d).delta;
    }
    if (t.u5h !== null) peak5h = Math.max(peak5h, t.u5h);
    if (t.r5h !== null && (t.u5h ?? 0) > 0) windows.add(Math.round(t.r5h / MINUTE));
  }

  const intervals = growthIntervals(ticks, { pauseMs: input.pauseMs }).filter((iv) => iv.end >= from && iv.start <= to);
  const workMinutes = intervals.reduce((s, iv) => s + (iv.end - iv.start) / MINUTE, 0);

  // k для периода и повторный прогон: отклонения и «доступно сейчас» по блокам.
  const ks = kSamples(ticks, settings.peak);
  const kEst = estimateK(ks);
  const points = replay(ticks, { settings, fixedK: kEst });
  const pointsInRange = points.filter((p) => p.ts >= from);

  const series = dailySeries(ticks, tz, settings.schedule, from, to);
  const vac = (ms: number) => (input.vacations ?? []).some((v) => ms >= v.from && (v.to === null || ms < v.to));
  const days: StatsDay[] = series.map((r) => {
    const dayEnd = Math.min(nextDayStartMs(r.start, tz), to);
    const dayPoints = pointsInRange.filter((p) => p.ts >= r.start && p.ts < dayEnd);
    const last = dayPoints[dayPoints.length - 1];
    const growthMinutes = intervals.reduce((s, iv) => {
      const ov = Math.min(iv.end, dayEnd) - Math.max(iv.start, r.start);
      return ov > 0 ? s + ov / MINUTE : s;
    }, 0);
    return {
      date: r.date,
      gain5h: r.gain5h,
      gain7d: r.gain7d,
      workHours: r.workHours,
      growthMinutes,
      vacation: vac(r.start),
      deviationEnd: last?.state.deviation ?? null,
    };
  });

  // Блоки расписания: X(t) и отклонение на начало и конец каждого блока.
  const blocks: BlockReport[] = activeIntervals(settings.schedule, from, Math.min(to, now)).map((b) => {
    const pts = pointsInRange.filter((p) => p.ts >= b.start && p.ts <= b.end);
    const a = pts[0];
    const z = pts[pts.length - 1];
    let g5 = 0;
    let g7 = 0;
    for (let i = 1; i < pts.length; i++) {
      g5 += windowDelta(pts[i - 1].tick.u5h, pts[i].tick.u5h, pts[i - 1].tick.r5h, pts[i].tick.r5h).delta;
      g7 += windowDelta(pts[i - 1].tick.u7d, pts[i].tick.u7d, pts[i - 1].tick.r7d, pts[i].tick.r7d).delta;
    }
    return {
      date: b.date,
      index: b.index,
      start: b.start,
      end: b.end,
      availableStart: a?.state.available ?? null,
      availableEnd: z?.state.available ?? null,
      deviationStart: a?.state.deviation ?? null,
      deviationEnd: z?.state.deviation ?? null,
      gain5h: g5,
      gain7d: g7,
    };
  });

  // Модель и режим: время работы по росту процента и по времени завершённых задач.
  const timeline = buildTimeline({ tasks: input.tasks, samples: input.samples, now });
  const attributed = attribute(intervals, timeline);
  const tasks = taskTime(input.tasks, from, to);
  const keyOf = (m: string, e: string | null, s: string | null) => `${m}\u0000${e ?? ''}\u0000${s ?? ''}`;
  const rows = new Map<string, ModelStatsRow>();
  const row = (m: string, e: string | null, s: string | null): ModelStatsRow => {
    const k = keyOf(m, e, s);
    let r = rows.get(k);
    if (!r) {
      r = {
        model: m,
        effort: e,
        surface: s,
        growthMinutes: 0,
        taskMinutes: 0,
        taskCount: 0,
        d5h: 0,
        d7d: 0,
        pct5hPerHour: null,
        pct7dPerHour: null,
        estimated: m === UNKNOWN_MODEL,
      };
      rows.set(k, r);
    }
    return r;
  };
  for (const a of attributed) {
    const r = row(a.model, a.effort, a.surface);
    r.growthMinutes += a.minutes;
    r.d5h += a.d5h;
    r.d7d += a.d7d;
  }
  for (const t of tasks) {
    const r = row(t.model, t.effort, t.surface);
    r.taskMinutes += t.minutes;
    r.taskCount += t.count;
  }
  const models = [...rows.values()].map((r) => {
    const denom = r.taskMinutes > 0 ? r.taskMinutes : r.growthMinutes;
    return { ...r, pct5hPerHour: perHour(r.d5h, denom), pct7dPerHour: perHour(r.d7d, denom) };
  });
  models.sort((a, b) => b.d7d - a.d7d || b.growthMinutes - a.growthMinutes);

  // Пиковые и непиковые часы отдельно.
  const regime = (peak: boolean): RegimeRow => {
    let ms = 0;
    let d5 = 0;
    let d7 = 0;
    for (const iv of intervals) {
      const mid = iv.start + (iv.end - iv.start) / 2;
      if (isPeak(settings.peak, mid) !== peak) continue;
      ms += iv.end - iv.start;
      d5 += iv.d5h;
      d7 += iv.d7d;
    }
    const minutes = ms / MINUTE;
    return {
      hours: minutes / 60,
      d5h: d5,
      d7d: d7,
      pct5hPerHour: perHour(d5, minutes),
      pct7dPerHour: perHour(d7, minutes),
      k: peak ? kEst.peak : kEst.offpeak,
      samples: peak ? kEst.nPeak : kEst.nOffpeak,
    };
  };

  // Тепловая карта «час × день недели».
  const cells = new Map<string, HeatCell>();
  for (const iv of intervals) {
    for (const s of splitByHour(iv, tz)) {
      const k = `${s.weekday}-${s.hour}`;
      let c = cells.get(k);
      if (!c) {
        c = { weekday: s.weekday, hour: s.hour, minutes: 0, d5h: 0, d7d: 0, pct7dPerHour: null, pct5hPerHour: null };
        cells.set(k, c);
      }
      c.minutes += s.ms / MINUTE;
      c.d5h += iv.d5h * s.share;
      c.d7d += iv.d7d * s.share;
    }
  }
  const heatmap = [...cells.values()].map((c) => ({
    ...c,
    pct7dPerHour: c.minutes >= 10 ? perHour(c.d7d, c.minutes) : null,
    pct5hPerHour: c.minutes >= 10 ? perHour(c.d5h, c.minutes) : null,
  }));

  // Остаток времени: сколько рабочих часов хватит при текущем темпе.
  const lastPoint = replay(inRange.length ? inRange.slice(-1) : [], { settings, fixedK: kEst })[0];
  const speed = speed7dOf(input.ticks.filter((t) => t.ts <= now), settings, now);
  const uNow = input.ticks.length ? input.ticks[input.ticks.length - 1].u7d : null;
  const remainingHours = lastPoint?.state.remainingHours ?? 0;
  const hoursLeft = uNow !== null && speed && speed > 0 ? Math.max(0, 100 - uNow) / speed : null;

  return {
    kind: input.kind,
    mode: input.mode,
    from,
    to,
    totals: { gain5h, gain7d, peak5h, windows: windows.size, workMinutes },
    days,
    blocks,
    models,
    peakSplit: { peak: regime(true), offpeak: regime(false) },
    heatmap,
    timeLeft: {
      speed7d: speed,
      hoursLeft,
      remainingHours,
      notEnough: hoursLeft !== null && hoursLeft < remainingHours,
    },
  };
}

