import { describe, expect, it } from 'vitest';
import { activeIntervals, blockAt, defaultSchedule, weightedHours, currentOrNextBlock } from '../src/index.js';
import { msk } from './helpers.js';

describe('расписание по умолчанию', () => {
  it('даёт 40 активных часов в неделю, выходные не входят', () => {
    const s = defaultSchedule();
    // 2026-11-02 — понедельник
    expect(weightedHours(s, msk('2026-11-02', '00:00'), msk('2026-11-09', '00:00'))).toBeCloseTo(40, 9);
    expect(weightedHours(s, msk('2026-11-07', '00:00'), msk('2026-11-09', '00:00'))).toBe(0);
  });

  it('блоки: 10–14 и 15–19, обед не считается', () => {
    const s = defaultSchedule();
    expect(blockAt(s, msk('2026-11-03', '10:00'))?.index).toBe(0);
    expect(blockAt(s, msk('2026-11-03', '13:59'))?.index).toBe(0);
    expect(blockAt(s, msk('2026-11-03', '14:00'))).toBeNull();
    expect(blockAt(s, msk('2026-11-03', '14:30'))).toBeNull();
    expect(blockAt(s, msk('2026-11-03', '15:00'))?.index).toBe(1);
    expect(blockAt(s, msk('2026-11-03', '19:00'))).toBeNull();
    expect(blockAt(s, msk('2026-11-07', '11:00'))).toBeNull();
  });

  it('ближайший блок в субботу — утренний блок понедельника', () => {
    const b = currentOrNextBlock(defaultSchedule(), msk('2026-11-07', '12:00'))!;
    expect(b.start).toBe(msk('2026-11-09', '10:00'));
    expect(b.end).toBe(msk('2026-11-09', '14:00'));
  });

  it('исключения: выходной в рабочий день и рабочая суббота', () => {
    const s = { ...defaultSchedule(), exceptions: [{ date: '2026-11-03', type: 'off' as const }, { date: '2026-11-07', type: 'work' as const }] };
    expect(weightedHours(s, msk('2026-11-03', '00:00'), msk('2026-11-04', '00:00'))).toBe(0);
    expect(weightedHours(s, msk('2026-11-07', '00:00'), msk('2026-11-08', '00:00'))).toBeCloseTo(8, 9);
    expect(weightedHours(s, msk('2026-11-02', '00:00'), msk('2026-11-09', '00:00'))).toBeCloseTo(40, 9);
  });

  it('веса блоков меняют вклад часов', () => {
    const s = defaultSchedule();
    s.blocks = s.blocks.map((b) => (b.start === '15:00' ? { ...b, weight: 0.5 } : b));
    expect(weightedHours(s, msk('2026-11-02', '00:00'), msk('2026-11-09', '00:00'))).toBeCloseTo(30, 9);
  });

  it('интервалы не пересекаются и идут по порядку', () => {
    const list = activeIntervals(defaultSchedule(), msk('2026-11-02', '00:00'), msk('2026-11-16', '00:00'));
    expect(list).toHaveLength(20);
    for (let i = 1; i < list.length; i++) expect(list[i].start).toBeGreaterThanOrEqual(list[i - 1].end);
  });
});
