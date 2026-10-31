import {
  HOUR,
  addDays,
  nextDayStartMs,
  overlapMs,
  parseHm,
  toZoned,
  weekdayOf,
  zonedToMs,
} from './time.js';

/** Рабочий блок (строка таблицы schedule). */
export interface ScheduleBlock {
  /** 1 = понедельник … 7 = воскресенье */
  weekday: number;
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
  /** Вес блока в недельном бюджете; 0 — блок не учитывается. */
  weight: number;
}

/** Исключение из расписания (таблица schedule_exception). */
export interface ScheduleException {
  date: string; // YYYY-MM-DD в поясе расписания
  /** off — выходной в обычный рабочий день, work — рабочий в обычный выходной. */
  type: 'off' | 'work';
}

export interface Schedule {
  tz: string;
  blocks: ScheduleBlock[];
  exceptions: ScheduleException[];
}

export interface ActiveInterval {
  start: number;
  end: number;
  weight: number;
  date: string;
  /** Номер блока внутри дня: 0 — утренний, 1 — вечерний. */
  index: number;
}

/** По умолчанию: пн–пт, 10:00–14:00 и 15:00–19:00 по UTC+3, блоки равны по весу (40 часов в неделю). */
export function defaultSchedule(): Schedule {
  const blocks: ScheduleBlock[] = [];
  for (let weekday = 1; weekday <= 5; weekday++) {
    blocks.push({ weekday, start: '10:00', end: '14:00', weight: 1 });
    blocks.push({ weekday, start: '15:00', end: '19:00', weight: 1 });
  }
  return { tz: 'UTC+3', blocks, exceptions: [] };
}

function blocksForDate(s: Schedule, key: string): ScheduleBlock[] {
  const exc = s.exceptions.find((e) => e.date === key);
  const weekday = weekdayOf(key);
  if (exc?.type === 'off') return [];
  const own = s.blocks.filter((b) => b.weekday === weekday && b.weight > 0);
  if (exc?.type === 'work' && own.length === 0) {
    // Рабочий день на выходной: берём блоки первого дня недели, у которого они есть.
    for (let wd = 1; wd <= 7; wd++) {
      const tpl = s.blocks.filter((b) => b.weekday === wd && b.weight > 0);
      if (tpl.length) return tpl;
    }
    return [];
  }
  return own;
}

/** Активные интервалы, пересекающиеся с [from, to], по возрастанию времени. Интервалы не обрезаются по границам. */
export function activeIntervals(s: Schedule, from: number, to: number): ActiveInterval[] {
  const out: ActiveInterval[] = [];
  if (to <= from) return out;
  const last = toZoned(to, s.tz).dateKey;
  let key = toZoned(from, s.tz).dateKey;
  // Блок, начавшийся накануне и пересекающий полночь, не поддерживается: блоки живут внутри одних суток.
  for (let guard = 0; guard < 4000; guard++) {
    const day = blocksForDate(s, key)
      .map((b) => ({ b, startMin: parseHm(b.start) }))
      .sort((x, y) => x.startMin - y.startMin);
    day.forEach(({ b, startMin }, index) => {
      const start = zonedToMs(key, startMin, s.tz);
      const end = zonedToMs(key, parseHm(b.end), s.tz);
      if (end > from && start < to && end > start) out.push({ start, end, weight: b.weight, date: key, index });
    });
    if (key >= last) break;
    key = addDays(key, 1);
  }
  return out;
}

/** Сумма «взвешенных» активных часов расписания на отрезке [from, to]. */
export function weightedHours(s: Schedule, from: number, to: number): number {
  let total = 0;
  for (const iv of activeIntervals(s, from, to)) {
    total += (overlapMs(iv.start, iv.end, from, to) / HOUR) * iv.weight;
  }
  return total;
}

/** Блок, в который попадает момент t, иначе null. */
export function blockAt(s: Schedule, t: number): ActiveInterval | null {
  return activeIntervals(s, t, t + 1).find((iv) => iv.start <= t && t < iv.end) ?? null;
}

/** Ближайший блок, который ещё не закончился на момент t (текущий или следующий). */
export function currentOrNextBlock(s: Schedule, t: number, horizonDays = 14): ActiveInterval | null {
  const list = activeIntervals(s, t, t + horizonDays * 24 * HOUR);
  return list.find((iv) => iv.end > t) ?? null;
}

/** Оставшиеся взвешенные активные часы сегодня (до конца локальных суток). */
export function remainingHoursToday(s: Schedule, t: number, limit = Infinity): number {
  const end = Math.min(nextDayStartMs(t, s.tz), limit);
  return weightedHours(s, t, end);
}

export function isWorkingTime(s: Schedule, t: number): boolean {
  return blockAt(s, t) !== null;
}
