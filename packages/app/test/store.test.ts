import { afterEach, describe, expect, it } from 'vitest';
import { defaultSchedule, type Snapshot } from '@limit-budget/core';
import { Store } from '../src/shared/db.js';
import { defaultSettings } from '../src/shared/settings.js';

const stores: Store[] = [];
const mk = () => {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
};
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const snap = (ts: number, window: '5h' | '7d', pct: number, over: Partial<Snapshot> = {}): Snapshot => ({
  ts,
  provider: 'claude',
  window,
  bucket: 'all',
  usedPct: pct,
  resetsAt: ts + 1000,
  source: 'test',
  ...over,
});

describe('хранилище', () => {
  it('снимки: запись, чтение, повторная запись того же момента заменяет строку', () => {
    const s = mk();
    s.insertSnapshots([snap(1000, '5h', 10), snap(1000, '7d', 20), snap(2000, '5h', 12)]);
    s.insertSnapshots([snap(2000, '5h', 13)]);
    const rows = s.getSnapshots('claude');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.ts === 2000)?.usedPct).toBe(13);
    expect(s.getTicks('claude')[0]).toMatchObject({ ts: 1000, u5h: 10, u7d: 20 });
    expect(s.lastSnapshotTs('claude')).toBe(2000);
    expect(s.lastSnapshotTs('chatgpt')).toBeNull();
  });

  it('провайдеры не смешиваются: одна схема для claude и chatgpt', () => {
    const s = mk();
    s.insertSnapshots([snap(1000, '5h', 10), snap(1000, '5h', 55, { provider: 'chatgpt' })]);
    expect(s.getSnapshots('claude')).toHaveLength(1);
    expect(s.getSnapshots('chatgpt')[0].usedPct).toBe(55);
  });

  it('расписание и исключения сохраняются и читаются, по умолчанию — стандартное', () => {
    const s = mk();
    expect(s.loadSchedule()).toEqual(defaultSchedule());
    const custom = { ...defaultSchedule(), exceptions: [{ date: '2026-11-04', type: 'off' as const }, { date: '2026-11-07', type: 'work' as const }] };
    s.saveSchedule(custom);
    expect(s.loadSchedule()).toEqual(custom);
  });

  it('настройки: значения по умолчанию, слияние, переживают перезапись', () => {
    const s = mk();
    expect(s.loadSettings()).toEqual(defaultSettings());
    const next = { ...defaultSettings(), reserve: 0.2, manualK: null };
    s.saveSettings(next);
    expect(s.loadSettings().reserve).toBe(0.2);
    expect(s.loadSettings().manualK).toBeNull();
  });

  it('режим и периоды отпуска', () => {
    const s = mk();
    expect(s.getMode()).toBe('work');
    s.setMode('vacation', 1000);
    s.setMode('vacation', 1500); // повтор не плодит записи
    s.setMode('work', 2000);
    s.setMode('vacation', 3000);
    expect(s.getMode()).toBe('vacation');
    expect(s.vacationRanges()).toEqual([
      { from: 1000, to: 2000 },
      { from: 3000, to: null },
    ]);
  });

  it('аномалия за день записывается один раз', () => {
    const s = mk();
    const a = { ts: Date.parse('2026-11-03T09:00:00Z'), provider: 'claude' as const, window: '7d' as const, kind: 'drop' as const, ratio: 1.4, note: 'x' };
    expect(s.addAnomaly(a, 'UTC+3')).toBe(true);
    expect(s.addAnomaly({ ...a, ts: a.ts + 3_600_000 }, 'UTC+3')).toBe(false);
    expect(s.addAnomaly({ ...a, ts: a.ts + 86_400_000 }, 'UTC+3')).toBe(true);
    expect(s.listAnomalies()).toHaveLength(2);
  });

  it('ручные пометки', () => {
    const s = mk();
    const id = s.addNote(1000, 'лимиты подняли', 'claude');
    s.addNote(2000, 'ещё');
    expect(s.listNotes().map((n) => n.text)).toEqual(['ещё', 'лимиты подняли']);
    s.deleteNote(id);
    expect(s.listNotes()).toHaveLength(1);
  });

  it('очистка: сырая активность по сроку, снимки бессрочно', () => {
    const s = mk();
    const now = 200 * 86_400_000;
    s.insertSnapshots([snap(1000, '5h', 10)]);
    s.insertInterval('claude', { start: 1000, end: 2000, d5h: 1, d7d: 0 });
    s.insertInterval('claude', { start: now - 1000, end: now, d5h: 1, d7d: 0 });
    s.insertModelSample({ ts: 1000, provider: 'claude', surface: null, model: 'opus', effort: null, source: 'manual' });
    expect(s.purgeRaw(now, 90)).toBe(2);
    expect(s.getIntervals('claude', 0, now)).toHaveLength(1);
    expect(s.getSnapshots('claude')).toHaveLength(1);
  });

  it('курсор чтения логов и события использования (заготовка под Codex)', () => {
    const s = mk();
    expect(s.getCursor('chatgpt', 'a.jsonl')).toBe(0);
    s.setCursor('chatgpt', 'a.jsonl', 4096);
    expect(s.getCursor('chatgpt', 'a.jsonl')).toBe(4096);
    s.insertUsageEvents([{ provider: 'chatgpt', ts: 1, model: 'gpt-5-codex', effort: 'high', tokens: 1500 }]);
  });

  it('модельные отметки: последняя отметка до периода тоже возвращается', () => {
    const s = mk();
    s.insertModelSample({ ts: 100, provider: 'claude', surface: 'chat', model: 'opus', effort: null, source: 'manual' });
    s.insertModelSample({ ts: 500, provider: 'claude', surface: 'chat', model: 'sonnet', effort: null, source: 'manual' });
    const got = s.getModelSamples('claude', 300, 1000);
    expect(got.map((m) => m.model)).toEqual(['opus', 'sonnet']);
  });
});
