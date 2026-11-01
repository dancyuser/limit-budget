import { HOUR, DAY, addDays, toZoned, weekStartMs, zonedToMs } from './time.js';
import { currentOrNextBlock, remainingHoursToday, weightedHours, type Schedule } from './schedule.js';
import { isPeak, type PeakProfile } from './peak.js';
import type { KEstimate } from './ticks.js';
import type { AppMode } from './types.js';

export interface BudgetSettings {
  /** Резерв недельного лимита на непредвиденное, доля (0,1 = 10%). */
  reserve: number;
  /** Порог отклонения δ от траектории, п.п. */
  deviationPct: number;
  /** «Доступно сейчас» меньше этого значения — предупреждение, п.п. */
  lowAvailablePct: number;
  schedule: Schedule;
  peak: PeakProfile;
  /** Ручное k до накопления данных: сколько п.п. недели съедает 1 п.п. 5-часового окна. */
  manualK: number | null;
}

export interface BudgetInput {
  now: number;
  mode: AppMode;
  u5h: number | null;
  r5h: number | null;
  u7d: number | null;
  r7d: number | null;
  k?: KEstimate | null;
  /** Текущая скорость роста 5-часового процента, п.п. в час. */
  rate5h?: number | null;
  /** Медианная скорость расхода недели за последние 14 рабочих дней, п.п. за рабочий час. */
  speed7d?: number | null;
  /** Данные устарели (опрос давно не удавался). */
  stale?: boolean;
}

export type BudgetStatus = 'off' | 'unknown' | 'above' | 'ok' | 'reserve';
export type KSource = 'peak' | 'offpeak' | 'manual' | 'other';

export interface BudgetState {
  mode: AppMode;
  stale: boolean;
  week: { start: number; end: number; source: 'resets_at' | 'calendar' };
  /** A — все взвешенные активные часы окна недели; a — пройденные. */
  A: number;
  a: number;
  remainingHours: number;
  /** T(t), п.п. недельного лимита. */
  target: number | null;
  usedWeek: number | null;
  /** u − T */
  deviation: number | null;
  status: BudgetStatus;
  /** ρ(t): допустимая скорость, п.п. за рабочий час. */
  rho: number | null;
  /** D(t): рекомендуемый уровень недели на конец дня. */
  dayTarget: number | null;
  hoursLeftToday: number;
  block: { start: number; end: number; inBlock: boolean; index: number } | null;
  /** S — недельная цель на конец блока. */
  blockTarget: number | null;
  k: number | null;
  kSource: KSource | null;
  /** C — ёмкость недели в полных 5-часовых окнах. */
  capacityWindows: number | null;
  /** X(t) — сколько п.п. текущего 5-часового окна можно потратить; null, если у провайдера нет 5-часового окна. */
  available: number | null;
  limitedBy: 'window' | 'week' | null;
  u5hEffective: number | null;
  peakNow: boolean;
  /** H_left и признак «не хватит». */
  hoursLeft: number | null;
  notEnough: boolean;
  /** Прогноз: 5-часовое окно исчерпается раньше конца блока. */
  windowExhaustsEarly: boolean;
  hoursToExhaust: number | null;
  /** Пятичасовое окно по времени закончится раньше блока (подсказка в карточке). */
  windowResetsBeforeBlockEnd: boolean;
  lowAvailable: boolean;
  /** Блок исчерпан или неделя выбрана до цели: сигнал превышения лимита. */
  exceeded: boolean;
}

/** Окно недели берётся из resets_at недельного лимита, а не из календаря. */
export function weekWindow(
  now: number,
  r7d: number | null,
  schedule: Schedule,
): { start: number; end: number; source: 'resets_at' | 'calendar'; rolled: boolean } {
  if (r7d !== null) {
    let end = r7d;
    let rolled = false;
    while (now >= end) {
      end += 7 * DAY;
      rolled = true;
    }
    return { start: end - 7 * DAY, end, source: 'resets_at', rolled };
  }
  const start = weekStartMs(now, schedule.tz);
  const end = zonedToMs(addDays(toZoned(start, schedule.tz).dateKey, 7), 0, schedule.tz);
  return { start, end, source: 'calendar', rolled: false };
}

/** Целевой процент недели к моменту t: T(t) = 100·(1 − r)·a(t)/A. */
export function targetAt(schedule: Schedule, week: { start: number; end: number }, t: number, reserve: number): number | null {
  const A = weightedHours(schedule, week.start, week.end);
  if (A <= 0) return null;
  const a = weightedHours(schedule, week.start, Math.max(week.start, Math.min(t, week.end)));
  return (100 * (1 - reserve) * a) / A;
}

function pickK(
  est: KEstimate | null | undefined,
  peakNow: boolean,
  manual: number | null,
): { k: number; source: KSource } | null {
  const own = peakNow ? est?.peak : est?.offpeak;
  if (own && own > 0) return { k: own, source: peakNow ? 'peak' : 'offpeak' };
  if (manual && manual > 0) return { k: manual, source: 'manual' };
  const other = peakNow ? est?.offpeak : est?.peak;
  if (other && other > 0) return { k: other, source: 'other' };
  return null;
}

export function evaluateBudget(input: BudgetInput, s: BudgetSettings): BudgetState {
  const { now } = input;
  const week = weekWindow(now, input.r7d, s.schedule);
  const A = weightedHours(s.schedule, week.start, week.end);
  const a = weightedHours(s.schedule, week.start, Math.max(week.start, Math.min(now, week.end)));
  const peakNow = isPeak(s.peak, now);
  const stale = !!input.stale || week.rolled;

  // 5-часовое окно, у которого время сброса прошло, считается пустым.
  const u5hEff =
    input.u5h === null ? null : input.r5h !== null && input.r5h <= now ? 0 : input.u5h;
  // Неделя, у которой время сброса прошло (данные устарели, например после гибернации), началась заново: расход прошлой недели к ней не относится.
  const u7d = week.rolled && input.u7d !== null ? 0 : input.u7d;

  const base: BudgetState = {
    mode: input.mode,
    stale,
    week: { start: week.start, end: week.end, source: week.source },
    A,
    a,
    remainingHours: Math.max(0, A - a),
    target: null,
    usedWeek: u7d,
    deviation: null,
    status: 'off',
    rho: null,
    dayTarget: null,
    hoursLeftToday: 0,
    block: null,
    blockTarget: null,
    k: null,
    kSource: null,
    capacityWindows: null,
    available: null,
    limitedBy: null,
    u5hEffective: u5hEff,
    peakNow,
    hoursLeft: null,
    notEnough: false,
    windowExhaustsEarly: false,
    hoursToExhaust: null,
    windowResetsBeforeBlockEnd: false,
    lowAvailable: false,
    exceeded: false,
  };

  // «Отпуск»: цели и сигналы выключены, шкалы процентов и время сброса остаются.
  if (input.mode === 'vacation') return base;

  const budgetPct = 100 * (1 - s.reserve);
  const T = A > 0 ? (budgetPct * a) / A : null;
  base.target = T;

  if (u7d !== null && T !== null) {
    base.deviation = u7d - T;
    base.status =
      u7d > T + s.deviationPct ? 'above' : u7d < T - s.deviationPct ? 'reserve' : 'ok';
  } else {
    base.status = 'unknown';
  }

  // ρ(t) и D(t): подсказка пересчитывается от фактического расхода и сама гасит перерасход или недорасход.
  base.hoursLeftToday = remainingHoursToday(s.schedule, now, week.end);
  if (u7d !== null && A - a > 1e-9) {
    const rho = (budgetPct - u7d) / (A - a);
    base.rho = rho;
    base.dayTarget = u7d + Math.max(0, rho) * base.hoursLeftToday;
  }

  // Блок, относительно которого считается «доступно сейчас»: текущий либо ближайший следующий.
  const blk = currentOrNextBlock(s.schedule, now);
  if (blk) {
    base.block = { start: blk.start, end: blk.end, inBlock: blk.start <= now && now < blk.end, index: blk.index };
    base.windowResetsBeforeBlockEnd = input.r5h !== null && input.r5h > now && input.r5h < blk.end && base.block.inBlock;
  }

  const kPick = pickK(input.k, peakNow, s.manualK);
  base.k = kPick?.k ?? null;
  base.kSource = kPick?.source ?? null;
  base.capacityWindows = kPick ? (1 - s.reserve) / kPick.k : null;

  // Недельная цель на конец блока S. Если блок уже в следующей неделе, считаем от нуля нового окна.
  let S: number | null = null;
  let u7ForBlock = u7d;
  let u5ForBlock = u5hEff;
  if (blk) {
    if (blk.start >= week.end) {
      const nextWeek = { start: week.end, end: week.end + 7 * DAY };
      S = targetAt(s.schedule, nextWeek, blk.end, s.reserve);
      u7ForBlock = 0;
      u5ForBlock = input.r5h !== null && input.r5h <= blk.start ? 0 : u5hEff;
    } else {
      S = targetAt(s.schedule, week, blk.end, s.reserve);
    }
  }
  base.blockTarget = S;

  // X(t) = min(100 − u5h, (S − u7d)/k). Если 5-часового окна нет, X не считается.
  if (u5ForBlock !== null && u7ForBlock !== null && S !== null) {
    const windowLeft = Math.max(0, 100 - u5ForBlock);
    if (kPick) {
      const weekLeft = Math.max(0, (S - u7ForBlock) / kPick.k);
      base.available = Math.min(windowLeft, weekLeft);
      base.limitedBy = weekLeft < windowLeft ? 'week' : 'window';
    } else {
      base.available = windowLeft;
      base.limitedBy = 'window';
    }
    base.lowAvailable = base.available <= s.lowAvailablePct;
  }

  // Прогноз исчерпания 5-часового окна до конца блока при текущей скорости.
  if (base.block?.inBlock && u5hEff !== null && input.rate5h && input.rate5h > 0) {
    const capacity = Math.max(0, 100 - u5hEff);
    const toExhaust = capacity / input.rate5h;
    let horizon = (base.block.end - now) / HOUR;
    if (input.r5h !== null && input.r5h > now) horizon = Math.min(horizon, (input.r5h - now) / HOUR);
    base.hoursToExhaust = toExhaust;
    base.windowExhaustsEarly = toExhaust < horizon;
  }

  // H_left = (100 − u)/v̄: хватит ли недельного остатка при текущем темпе.
  if (u7d !== null && input.speed7d && input.speed7d > 0) {
    base.hoursLeft = Math.max(0, 100 - u7d) / input.speed7d;
    base.notEnough = base.hoursLeft < base.remainingHours;
  }

  // Превышение: блок исчерпан (X = 0 внутри блока) либо недельный расход дошёл до недельной цели 100·(1 − r).
  const blockSpent = !!base.block?.inBlock && base.available !== null && base.available <= 0;
  const weekSpent = u7d !== null && u7d >= budgetPct;
  base.exceeded = blockSpent || weekSpent;
  return base;
}
