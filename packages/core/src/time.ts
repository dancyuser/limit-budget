// Работа с часовыми поясами без внешних библиотек.
// Пояс задаётся строкой: 'UTC+3', 'UTC-05:30' (фиксированное смещение) или именем IANA ('America/Los_Angeles').

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const FIXED = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i;

export function parseFixedOffset(tz: string): number | null {
  if (/^(UTC|GMT|Z)$/i.test(tz)) return 0;
  const m = FIXED.exec(tz.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Смещение пояса от UTC в минутах на момент atMs. */
export function tzOffsetMinutes(tz: string, atMs: number): number {
  const fixed = parseFixedOffset(tz);
  if (fixed !== null) return fixed;
  const parts = dtf(tz).formatToParts(new Date(atMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / MINUTE);
}

export interface Zoned {
  year: number;
  month: number; // 1..12
  day: number;
  /** 1 = понедельник … 7 = воскресенье */
  weekday: number;
  minutesOfDay: number;
  dateKey: string; // 'YYYY-MM-DD'
}

export function toZoned(ms: number, tz: string): Zoned {
  const off = tzOffsetMinutes(tz, ms);
  const d = new Date(ms + off * MINUTE);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const js = d.getUTCDay();
  return {
    year,
    month,
    day,
    weekday: js === 0 ? 7 : js,
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateKey: dateKey(year, month, day),
  };
}

export function dateKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y, month: m, day: d };
}

export function addDays(key: string, n: number): string {
  const { year, month, day } = parseDateKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return dateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** День недели (1..7) для даты в формате YYYY-MM-DD. */
export function weekdayOf(key: string): number {
  const { year, month, day } = parseDateKey(key);
  const js = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** 'HH:MM' → минуты от полуночи. Допускается '24:00'. */
export function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function formatHm(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Локальное время (дата + минуты от полуночи) в поясе tz → epoch ms. Корректно при переходах на летнее время. */
export function zonedToMs(key: string, minutesOfDay: number, tz: string): number {
  const { year, month, day } = parseDateKey(key);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minutesOfDay * MINUTE;
  const fixed = parseFixedOffset(tz);
  if (fixed !== null) return naive - fixed * MINUTE;
  let guess = naive - tzOffsetMinutes(tz, naive) * MINUTE;
  guess = naive - tzOffsetMinutes(tz, guess) * MINUTE;
  return guess;
}

/** Граница следующего локального дня в поясе tz. */
export function nextDayStartMs(ms: number, tz: string): number {
  const z = toZoned(ms, tz);
  return zonedToMs(addDays(z.dateKey, 1), 0, tz);
}

export function dayStartMs(ms: number, tz: string): number {
  return zonedToMs(toZoned(ms, tz).dateKey, 0, tz);
}

/** Начало календарной недели (понедельник 00:00) в поясе tz. */
export function weekStartMs(ms: number, tz: string): number {
  const z = toZoned(ms, tz);
  return zonedToMs(addDays(z.dateKey, -(z.weekday - 1)), 0, tz);
}

export function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Медианное абсолютное отклонение (MAD), без поправки на нормальность. */
export function mad(values: number[], med = median(values)): number | null {
  if (med === null) return null;
  return median(values.map((v) => Math.abs(v - med)));
}
