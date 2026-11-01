import { describe, expect, it } from 'vitest';
import { MINUTE, SignalEngine, defaultSignalConfig, evaluateBudget, type BudgetInput, type SignalContext } from '../src/index.js';
import { msk, settings } from './helpers.js';

const S = settings();
const R7 = msk('2026-11-09', '10:00');
const base = (over: Partial<BudgetInput>): BudgetInput => ({
  now: msk('2026-11-03', '11:00'),
  mode: 'work',
  u5h: 10,
  r5h: msk('2026-11-03', '15:00'),
  u7d: 20,
  r7d: R7,
  ...over,
});
const ctx = (over: Partial<BudgetInput>, extra: Partial<SignalContext> = {}): SignalContext => {
  const input = base(over);
  return { now: input.now, budget: evaluateBudget(input, S), r5h: input.r5h, ...extra };
};
const at = (min: number) => msk('2026-11-03', '11:00') + min * MINUTE;

describe('сигналы: один раз за пересечение порога', () => {
  it('предупреждение звучит один раз, пока расход выше траектории', () => {
    const e = new SignalEngine({ ...defaultSignalConfig(), reminderMinutes: 0 });
    // T на 11:00 вторника = 18 + 2,25 = 20,25; δ = 5 → порог 25,25
    expect(e.update(ctx({ now: at(0), u7d: 20 }))).toEqual([]);
    const first = e.update(ctx({ now: at(1), u7d: 27 }));
    expect(first.map((x) => x.kind)).toContain('over-trajectory');
    expect(first.find((x) => x.kind === 'over-trajectory')!.severity).toBe('warning');
    expect(e.update(ctx({ now: at(2), u7d: 27.5 })).filter((x) => x.kind === 'over-trajectory')).toEqual([]);
    expect(e.update(ctx({ now: at(3), u7d: 28 })).filter((x) => x.kind === 'over-trajectory')).toEqual([]);
  });

  it('повторное напоминание идёт не чаще заданного интервала', () => {
    const e = new SignalEngine({ ...defaultSignalConfig(), reminderMinutes: 10 });
    const fired = (min: number) => e.update(ctx({ now: at(min), u7d: 27 })).filter((x) => x.kind === 'over-trajectory');
    expect(fired(0)).toHaveLength(1);
    expect(fired(5)).toHaveLength(0);
    const rem = fired(11);
    expect(rem).toHaveLength(1);
    expect(rem[0].reminder).toBe(true);
    expect(fired(15)).toHaveLength(0);
  });

  it('после снятия условия нужен период «взвода», иначе дребезг у порога не даёт новых сигналов', () => {
    const e = new SignalEngine({ ...defaultSignalConfig(), reminderMinutes: 0, rearmMinutes: 5 });
    const f = (min: number, u7d: number) => e.update(ctx({ now: at(min), u7d })).filter((x) => x.kind === 'over-trajectory');
    expect(f(0, 27)).toHaveLength(1);
    expect(f(1, 22)).toHaveLength(0); // условие снято
    expect(f(2, 27)).toHaveLength(0); // вернулось сразу — это тот же эпизод
    expect(f(3, 22)).toHaveLength(0);
    expect(f(9, 22)).toHaveLength(0); // условие снято 6 минут — сигнал взведён
    expect(f(10, 27)).toHaveLength(1);
  });

  it('превышение лимита — отдельный сигнал, а не предупреждение', () => {
    const e = new SignalEngine();
    // при мягкой раскладке превышение — это израсходованное 5-часовое окно (или недельный бюджет), а не опережение траектории
    const events = e.update(ctx({ u5h: 100, u7d: 18, now: msk('2026-11-03', '10:00') }));
    const ex = events.find((x) => x.kind === 'limit-exceeded');
    expect(ex?.severity).toBe('exceeded');
    expect(ex?.message).toContain('5-часовое окно');
    expect(events.find((x) => x.kind === 'low-available')).toBeUndefined();
  });

  it('окно исчерпается раньше блока — предупреждение', () => {
    const e = new SignalEngine();
    const events = e.update(ctx({ now: msk('2026-11-03', '12:00'), u5h: 60, r5h: msk('2026-11-03', '17:00'), rate5h: 30, u7d: 25 }));
    expect(events.map((x) => x.kind)).toContain('window-ends-early');
  });
});

describe('режим «Отпуск» и устаревшие данные', () => {
  it('в отпуске нет ни одного сигнала', () => {
    const e = new SignalEngine();
    expect(e.update(ctx({ mode: 'vacation', u5h: 99, u7d: 99 }))).toEqual([]);
  });

  it('устаревшие данные не дают ложных звуков', () => {
    const e = new SignalEngine();
    const c = ctx({ u7d: 90, u5h: 90 });
    c.budget = { ...c.budget, stale: true };
    expect(e.update(c)).toEqual([]);
  });
});

describe('необязательные тихие сигналы', () => {
  it('сброс окна и границы пика срабатывают, если включены', () => {
    const cfg = defaultSignalConfig();
    cfg.enabled['window-reset'] = true;
    cfg.enabled['peak-start'] = true;
    cfg.enabled['peak-end'] = true;
    const e = new SignalEngine(cfg);
    const day = '2026-11-03'; // зимнее время США, пик с 16:00 до 22:00 по UTC+3
    expect(e.update(ctx({ now: msk(day, '15:58'), r5h: msk(day, '17:00') }))).toEqual([]);
    const start = e.update(ctx({ now: msk(day, '16:01'), r5h: msk(day, '17:00') }));
    expect(start.map((x) => x.kind)).toEqual(['peak-start']);
    const reset = e.update(ctx({ now: msk(day, '17:05'), r5h: msk(day, '22:00') }));
    expect(reset.map((x) => x.kind)).toContain('window-reset');
    const end = e.update(ctx({ now: msk(day, '22:01'), r5h: msk(day, '22:00') }));
    expect(end.map((x) => x.kind)).toContain('peak-end');
  });

  it('по умолчанию тихие сигналы выключены', () => {
    const e = new SignalEngine();
    const day = '2026-11-03';
    e.update(ctx({ now: msk(day, '15:58'), r5h: msk(day, '17:00') }));
    expect(e.update(ctx({ now: msk(day, '16:01'), r5h: msk(day, '17:00') }))).toEqual([]);
  });

  it('возможное изменение лимитов подаёт отдельный сигнал', () => {
    const e = new SignalEngine();
    const events = e.update(
      ctx({ now: at(0) }, { newAnomalies: [{ ts: at(0), provider: 'claude', window: '7d', kind: 'drop', ratio: 1.4 }] }),
    );
    expect(events.map((x) => x.kind)).toContain('limits-changed');
  });
});
