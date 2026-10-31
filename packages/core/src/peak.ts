import { HOUR, addDays, formatHm, parseHm, toZoned, tzOffsetMinutes, weekdayOf, zonedToMs } from './time.js';

/**
 * Профиль пиковых часов. Задаётся в поясе, где Anthropic объявляет пик (America/Los_Angeles),
 * а пересчёт в UTC+3 делает Intl: переходы на летнее и зимнее время США получаются сами.
 */
export interface PeakProfile {
  enabled: boolean;
  tz: string;
  weekdays: number[]; // 1..7
  start: string; // HH:MM в поясе tz
  end: string;
}

export function defaultPeakProfile(): PeakProfile {
  return { enabled: true, tz: 'America/Los_Angeles', weekdays: [1, 2, 3, 4, 5], start: '05:00', end: '11:00' };
}

export interface PeakInterval {
  start: number;
  end: number;
}

/** Пиковые интервалы, пересекающие [from, to]. */
export function peakIntervals(p: PeakProfile, from: number, to: number): PeakInterval[] {
  if (!p.enabled || to <= from) return [];
  const out: PeakInterval[] = [];
  // Берём запас в сутки с обеих сторон: дата в поясе пика может отличаться от даты в поясе пользователя.
  const last = addDays(toZoned(to, p.tz).dateKey, 1);
  let key = addDays(toZoned(from, p.tz).dateKey, -1);
  for (let guard = 0; guard < 4000 && key <= last; guard++) {
    if (p.weekdays.includes(weekdayOf(key))) {
      const start = zonedToMs(key, parseHm(p.start), p.tz);
      const end = zonedToMs(key, parseHm(p.end), p.tz);
      if (end > from && start < to) out.push({ start, end });
    }
    key = addDays(key, 1);
  }
  return out;
}

export function isPeak(p: PeakProfile, t: number): boolean {
  return peakIntervals(p, t, t + 1).some((iv) => iv.start <= t && t < iv.end);
}

/** Пиковые часы на дату dateKey (по поясу пика), показанные в поясе displayTz — для подписи в виджете и тестов. */
export function peakWindowInZone(
  p: PeakProfile,
  dateKeyInPeakTz: string,
  displayTz: string,
): { start: string; end: string } | null {
  if (!p.enabled || !p.weekdays.includes(weekdayOf(dateKeyInPeakTz))) return null;
  const s = zonedToMs(dateKeyInPeakTz, parseHm(p.start), p.tz);
  const e = zonedToMs(dateKeyInPeakTz, parseHm(p.end), p.tz);
  const shift = (ms: number) => formatHm(((toZoned(ms, displayTz).minutesOfDay % 1440) + 1440) % 1440);
  return { start: shift(s), end: shift(e) };
}

/** Часов пика внутри [from, to]. */
export function peakHoursIn(p: PeakProfile, from: number, to: number): number {
  let ms = 0;
  for (const iv of peakIntervals(p, from, to)) ms += Math.max(0, Math.min(iv.end, to) - Math.max(iv.start, from));
  return ms / HOUR;
}

/** Смещение пояса пика от UTC в часах на момент t — удобно для диагностики летнего времени. */
export function peakOffsetHours(p: PeakProfile, t: number): number {
  return tzOffsetMinutes(p.tz, t) / 60;
}
