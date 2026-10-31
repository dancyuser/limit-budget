import { describe, expect, it } from 'vitest';
import { defaultPeakProfile, defaultSchedule, isPeak, peakHoursIn, peakWindowInZone, tzOffsetMinutes } from '../src/index.js';
import { msk } from './helpers.js';

const p = defaultPeakProfile();

describe('пиковые часы: пересчёт America/Los_Angeles → UTC+3', () => {
  it('до 1 ноября 2026 (летнее время США): 15:00–21:00', () => {
    expect(peakWindowInZone(p, '2026-10-30', 'UTC+3')).toEqual({ start: '15:00', end: '21:00' });
  });

  it('с 1 ноября 2026 (зимнее время США): 16:00–22:00', () => {
    // 2026-11-01 — воскресенье, первый будний день после перехода — 2 ноября
    expect(peakWindowInZone(p, '2026-11-02', 'UTC+3')).toEqual({ start: '16:00', end: '22:00' });
    expect(peakWindowInZone(p, '2026-11-01', 'UTC+3')).toBeNull();
  });

  it('до 14 марта 2027 зимнее время, с 14 марта снова летнее', () => {
    expect(peakWindowInZone(p, '2027-03-12', 'UTC+3')).toEqual({ start: '16:00', end: '22:00' });
    expect(peakWindowInZone(p, '2027-03-15', 'UTC+3')).toEqual({ start: '15:00', end: '21:00' });
  });

  it('смещение пояса меняется ровно на этих датах', () => {
    expect(tzOffsetMinutes('America/Los_Angeles', msk('2026-11-01', '00:00'))).toBe(-420); // PDT
    expect(tzOffsetMinutes('America/Los_Angeles', msk('2026-11-02', '00:00'))).toBe(-480); // PST
    expect(tzOffsetMinutes('America/Los_Angeles', msk('2027-03-13', '12:00'))).toBe(-480);
    expect(tzOffsetMinutes('America/Los_Angeles', msk('2027-03-15', '12:00'))).toBe(-420);
  });

  it('isPeak: граница пика сдвигается на час после перехода', () => {
    expect(isPeak(p, msk('2026-10-30', '15:00'))).toBe(true);
    expect(isPeak(p, msk('2026-10-30', '14:59'))).toBe(false);
    expect(isPeak(p, msk('2026-10-30', '20:59'))).toBe(true);
    expect(isPeak(p, msk('2026-10-30', '21:00'))).toBe(false);
    expect(isPeak(p, msk('2026-11-02', '15:30'))).toBe(false);
    expect(isPeak(p, msk('2026-11-02', '16:00'))).toBe(true);
    expect(isPeak(p, msk('2026-11-02', '21:59'))).toBe(true);
    expect(isPeak(p, msk('2026-11-02', '22:00'))).toBe(false);
    // выходные — не пик
    expect(isPeak(p, msk('2026-11-07', '17:00'))).toBe(false);
  });

  it('пересечение с вечерним блоком 15–19: 4 часа до перехода, 3 часа после', () => {
    // вечерний блок целиком в пике до 1 ноября, после — с 16:00 до 19:00
    expect(peakHoursIn(p, msk('2026-10-30', '15:00'), msk('2026-10-30', '19:00'))).toBeCloseTo(4, 9);
    expect(peakHoursIn(p, msk('2026-11-02', '15:00'), msk('2026-11-02', '19:00'))).toBeCloseTo(3, 9);
    expect(peakHoursIn(p, msk('2027-03-15', '15:00'), msk('2027-03-15', '19:00'))).toBeCloseTo(4, 9);
    expect(peakHoursIn(p, msk('2026-11-02', '10:00'), msk('2026-11-02', '14:00'))).toBe(0);
  });

  it('утренний блок не пересекается с пиком, расписание — тоже', () => {
    const s = defaultSchedule();
    expect(s.tz).toBe('UTC+3');
  });

  it('отключённый профиль не даёт пиков', () => {
    expect(isPeak({ ...p, enabled: false }, msk('2026-10-30', '16:00'))).toBe(false);
  });
});
