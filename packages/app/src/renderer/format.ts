export const pct = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(digits)}%`;

export const signed = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;

/** «через 2ч 15м», «через 4д 3ч», «сейчас». */
export function until(target: number | null, now: number): string {
  if (target === null) return '—';
  const ms = target - now;
  if (ms <= 0) return 'сейчас';
  const min = Math.round(ms / 60_000);
  const d = Math.floor(min / 1440);
  const hh = Math.floor((min % 1440) / 60);
  const mm = min % 60;
  if (d > 0) return `${d}д ${hh}ч`;
  if (hh > 0) return `${hh}ч ${String(mm).padStart(2, '0')}м`;
  return `${mm}м`;
}

export function hours(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const h = Math.floor(v);
  const m = Math.round((v - h) * 60);
  return m === 0 ? `${h} ч` : h === 0 ? `${m} мин` : `${h} ч ${m} мин`;
}

export function clock(ms: number, tz = 3): string {
  const d = new Date(ms + tz * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function dateTime(ms: number, tz = 3): string {
  const d = new Date(ms + tz * 3_600_000);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')} ${clock(ms, tz)}`;
}

export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
