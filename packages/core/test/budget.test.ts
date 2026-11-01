import { describe, expect, it } from 'vitest';
import { evaluateBudget, targetAt, weekWindow, defaultSchedule, DAY, type BudgetInput } from '../src/index.js';
import { msk, settings } from './helpers.js';

const S = settings();
// Неделя от понедельника 2026-11-02 10:00 до понедельника 2026-11-09 10:00 (по UTC+3)
const R7 = msk('2026-11-09', '10:00');

const input = (over: Partial<BudgetInput>): BudgetInput => ({
  now: msk('2026-11-03', '10:00'),
  mode: 'work',
  u5h: 0,
  r5h: null,
  u7d: 18,
  r7d: R7,
  ...over,
});

describe('траектория T(t) и резерв', () => {
  it('при 40 часах и резерве 10%: 2,25% в час, 9% на блок, 18% в день', () => {
    const week = weekWindow(msk('2026-11-03', '10:00'), R7, S.schedule);
    const t = (date: string, hm: string) => targetAt(S.schedule, week, msk(date, hm), 0.1)!;
    expect(t('2026-11-02', '11:00') - t('2026-11-02', '10:00')).toBeCloseTo(2.25, 9);
    expect(t('2026-11-02', '14:00') - t('2026-11-02', '10:00')).toBeCloseTo(9, 9);
    expect(t('2026-11-03', '10:00')).toBeCloseTo(18, 9);
    expect(t('2026-11-09', '10:00')).toBeCloseTo(90, 9);
  });

  it('без резерва: 2,5% в час, 10% на блок, 20% в день', () => {
    const week = weekWindow(msk('2026-11-03', '10:00'), R7, S.schedule);
    const t = (date: string, hm: string) => targetAt(S.schedule, week, msk(date, hm), 0)!;
    expect(t('2026-11-02', '11:00') - t('2026-11-02', '10:00')).toBeCloseTo(2.5, 9);
    expect(t('2026-11-03', '10:00')).toBeCloseTo(20, 9);
  });

  it('обед и выходные не двигают цель', () => {
    const week = weekWindow(msk('2026-11-03', '10:00'), R7, S.schedule);
    const t = (date: string, hm: string) => targetAt(S.schedule, week, msk(date, hm), 0.1)!;
    expect(t('2026-11-02', '14:00')).toBeCloseTo(t('2026-11-02', '15:00'), 9);
    expect(t('2026-11-06', '19:00')).toBeCloseTo(t('2026-11-08', '12:00'), 9);
  });
});

describe('окно недели берётся из resets_at', () => {
  it('сброс в середине недели (среда 13:00): неделя начинается в среду', () => {
    const r7 = msk('2026-11-11', '13:00'); // среда
    const w = weekWindow(msk('2026-11-09', '10:00'), r7, S.schedule);
    expect(w.start).toBe(msk('2026-11-04', '13:00'));
    expect(w.end).toBe(r7);
    expect(w.source).toBe('resets_at');
    // в окне ровно 40 активных часов: среда 13–14, 15–19, чт, пт, пн, вт, среда 10–13
    const st = evaluateBudget(input({ now: msk('2026-11-09', '10:00'), r7d: r7, u7d: 20 }), S);
    expect(st.A).toBeCloseTo(40, 9);
    // к понедельнику 10:00 прошло: ср (1+4) + чт 8 + пт 8 = 21 час
    expect(st.a).toBeCloseTo(21, 9);
    expect(st.target).toBeCloseTo((90 * 21) / 40, 9);
  });

  it('если resets_at уже прошёл, окно сдвигается и данные помечаются устаревшими', () => {
    const st = evaluateBudget(input({ now: msk('2026-11-10', '12:00'), r7d: R7 }), S);
    expect(st.stale).toBe(true);
    expect(st.week.end).toBe(R7 + 7 * DAY);
  });

  it('после прошедшего сброса недели расход прошлой недели не считается: нет ложного превышения', () => {
    // Снимок устарел (например, компьютер спал): неделя сбросилась в понедельник 10:00, сейчас вторник 12:00, а в снимке ещё 56%.
    const st = evaluateBudget(input({ now: msk('2026-11-10', '12:00'), r7d: R7, u7d: 56 }), S);
    expect(st.stale).toBe(true);
    expect(st.usedWeek).toBe(0);
    expect(st.deviation!).toBeLessThan(0);
    expect(st.status).not.toBe('above');
    expect(st.exceeded).toBe(false);
  });

  it('пока неделя не сбросилась, расход берётся как есть', () => {
    const st = evaluateBudget(input({ now: msk('2026-11-03', '10:00'), r7d: R7, u7d: 56 }), S);
    expect(st.stale).toBe(false);
    expect(st.usedWeek).toBe(56);
    expect(st.status).toBe('above');
  });

  it('без resets_at берётся календарная неделя пн–вс', () => {
    const st = evaluateBudget(input({ r7d: null }), S);
    expect(st.week.source).toBe('calendar');
    expect(st.week.start).toBe(msk('2026-11-02', '00:00'));
  });
});

describe('статусы относительно траектории', () => {
  it('выше T + δ — «выше траектории», ниже T − δ — «есть запас»', () => {
    // T = 18 в этот момент, δ = 5
    expect(evaluateBudget(input({ u7d: 24 }), S).status).toBe('above');
    expect(evaluateBudget(input({ u7d: 22 }), S).status).toBe('ok');
    expect(evaluateBudget(input({ u7d: 18 }), S).status).toBe('ok');
    expect(evaluateBudget(input({ u7d: 12 }), S).status).toBe('reserve');
  });

  it('ρ(t) и D(t) гасят перерасход: подсказка идёт от фактического расхода', () => {
    // Вторник 10:00: прошло 8 ч, осталось 32 ч. ρ = (90 − u)/32. При u=18 ρ = 2,25
    const onTrack = evaluateBudget(input({ u7d: 18 }), S);
    expect(onTrack.rho).toBeCloseTo(2.25, 9);
    expect(onTrack.hoursLeftToday).toBeCloseTo(8, 9);
    expect(onTrack.dayTarget).toBeCloseTo(18 + 2.25 * 8, 9);
    const over = evaluateBudget(input({ u7d: 30 }), S);
    expect(over.rho!).toBeLessThan(2.25);
    expect(over.rho).toBeCloseTo(60 / 32, 9);
    const under = evaluateBudget(input({ u7d: 10 }), S);
    expect(under.rho!).toBeGreaterThan(2.25);
  });
});

describe('«доступно сейчас» X(t)', () => {
  it('пример из плана: k = 0,15 → C = 6, в начале блока доступно 60% окна', () => {
    const st = evaluateBudget(input({ u5h: 0 }), S); // вторник 10:00, u7d = T = 18
    expect(st.k).toBeCloseTo(0.15, 9);
    expect(st.kSource).toBe('manual');
    expect(st.capacityWindows).toBeCloseTo(6, 9);
    expect(st.blockTarget).toBeCloseTo(27, 9);
    expect(st.available).toBeCloseTo(60, 9);
    expect(st.limitedBy).toBe('week');
  });

  it('если неделя не ограничивает, ограничивает само окно', () => {
    const st = evaluateBudget(input({ u5h: 70, u7d: 5 }), S);
    expect(st.available).toBeCloseTo(30, 9);
    expect(st.limitedBy).toBe('window');
  });

  it('превышение подаётся, когда израсходовано 5-часовое окно или недельный бюджет, а не когда траектория «обогнала» расход', () => {
    // Перерасход относительно траектории больше не обнуляет X: подробности в блоке «мягкая раскладка»
    const ahead = evaluateBudget(input({ u5h: 40, u7d: 27 }), S);
    expect(ahead.available!).toBeGreaterThan(0);
    expect(ahead.exceeded).toBe(false);
    const windowFull = evaluateBudget(input({ u5h: 100, u7d: 18 }), S);
    expect(windowFull.available).toBe(0);
    expect(windowFull.exceeded).toBe(true);
    const weekFull = evaluateBudget(input({ u5h: 10, u7d: 90 }), S);
    expect(weekFull.available).toBe(0);
    expect(weekFull.exceeded).toBe(true);
  });

  it('измеренное k для текущего режима важнее ручного, пик и вне пика отдельно', () => {
    const k = { peak: 0.1, offpeak: 0.2, nPeak: 9, nOffpeak: 9 };
    const off = evaluateBudget(input({ k, now: msk('2026-11-03', '10:00') }), S);
    expect(off.kSource).toBe('offpeak');
    expect(off.k).toBe(0.2);
    expect(off.available).toBeCloseTo(9 / 0.2, 9);
    // 2 ноября уже зимнее время США — пик с 16:00
    const peak = evaluateBudget(input({ k, now: msk('2026-11-03', '16:30'), u7d: 30 }), S);
    expect(peak.peakNow).toBe(true);
    expect(peak.kSource).toBe('peak');
    expect(peak.k).toBe(0.1);
  });

  it('в обед считаем от следующего (вечернего) блока', () => {
    const st = evaluateBudget(input({ now: msk('2026-11-03', '14:30'), u7d: 27 }), S);
    expect(st.block?.inBlock).toBe(false);
    expect(st.block?.start).toBe(msk('2026-11-03', '15:00'));
    expect(st.blockTarget).toBeCloseTo(36, 9);
    expect(st.available).toBeCloseTo(9 / 0.15, 9);
  });

  it('окно, у которого время сброса прошло, считается пустым', () => {
    const st = evaluateBudget(input({ u5h: 90, r5h: msk('2026-11-03', '09:30') }), S);
    expect(st.u5hEffective).toBe(0);
  });

  it('без k и без ручного значения X ограничен только окном', () => {
    const st = evaluateBudget(input({ u5h: 25 }), settings({ manualK: null }));
    expect(st.k).toBeNull();
    expect(st.available).toBe(75);
    expect(st.limitedBy).toBe('window');
  });
});

describe('мягкая раскладка: расход прошлых дней и часов пересчитывает бюджет оставшихся', () => {
  // Вторник 10:00: прошло 8 рабочих часов из 40, до конца блока 4 часа, k = 0,15, бюджет недели 90%
  const at = (u7d: number, over: Partial<BudgetInput> = {}) => evaluateBudget(input({ u5h: 0, u7d, ...over }), S);

  it('перерасход уменьшает бюджет следующих дней поровну, а не обнуляет «доступно сейчас»', () => {
    const over = at(30); // по плану было бы 18
    expect(over.rho).toBeCloseTo(60 / 32, 9);
    expect(over.dayTarget! - 30).toBeCloseTo(15, 9); // сегодня 15 п.п. вместо 18
    expect(over.blockTarget).toBeCloseTo(30 + (60 / 32) * 4, 9);
    expect(over.available).toBeCloseTo(((60 / 32) * 4) / 0.15, 9); // 50% окна, а не 0
    expect(over.limitedBy).toBe('week');
    expect(over.status).toBe('above'); // выше траектории: предупреждение остаётся
    expect(over.exceeded).toBe(false);
  });

  it('недорасход увеличивает бюджет следующих дней, но не даёт потратить накопленное разом', () => {
    const under = at(8);
    expect(under.dayTarget! - 8).toBeCloseTo(20.5, 9); // сегодня 20,5 п.п. вместо 18
    expect(under.available).toBeCloseTo(((82 / 32) * 4) / 0.15, 9); // 68,3% окна
    expect(under.available!).toBeGreaterThan(at(18).available!); // больше, чем «ровно по плану» (60%)
    expect(under.available!).toBeLessThan(100); // прежний расчёт по траектории разрешил бы 100% окна
  });

  it('бюджет дня: больше расход — меньше бюджет, меньше расход — больше', () => {
    const day = (u: number) => at(u).dayTarget! - u;
    expect(day(30)).toBeLessThan(day(18));
    expect(day(18)).toBeCloseTo(18, 9);
    expect(day(8)).toBeGreaterThan(day(18));
  });

  it('остаток недели всегда делится целиком: u + ρ·(оставшиеся часы) = 90%', () => {
    for (const u of [0, 8, 18, 30, 55]) {
      const st = at(u);
      expect(u + st.rho! * st.remainingHours).toBeCloseTo(90, 9);
    }
  });

  it('«доступно сейчас» монотонно убывает с расходом и становится нулём только при выбранном недельном бюджете', () => {
    let prev = Infinity;
    for (const u of [0, 10, 20, 30, 40, 60, 80, 89]) {
      const a = at(u).available!;
      expect(a).toBeLessThanOrEqual(prev);
      expect(a).toBeGreaterThan(0);
      prev = a;
    }
    expect(at(90).available).toBe(0);
    expect(at(95).available).toBe(0);
  });

  it('внутри блока раскладка пересчитывается каждый час: выход за траекторию сокращает X, но не до нуля', () => {
    // Вторник 12:00: на траектории u = 22,5, до конца блока 2 часа → X = 2,25·2/0,15 = 30%
    const now = msk('2026-11-03', '12:00');
    expect(at(22.5, { now }).available).toBeCloseTo(30, 9);
    const over = at(28.5, { now }); // на 6 п.п. выше траектории
    expect(over.rho).toBeCloseTo(61.5 / 30, 9);
    expect(over.available).toBeCloseTo(((61.5 / 30) * 2) / 0.15, 9); // ≈ 27,3%
    expect(over.available!).toBeLessThan(30);
    expect(over.available!).toBeGreaterThan(0);
  });

  it('блок следующей недели считается от нуля, как раньше', () => {
    // Воскресенье вечером: следующий блок уже в новой неделе, расход старой недели ему не мешает
    const st = evaluateBudget(input({ now: msk('2026-11-08', '20:00'), u5h: 0, u7d: 80 }), S);
    expect(st.block?.start).toBeGreaterThanOrEqual(R7);
    expect(st.available).toBeCloseTo(((90 / 40) * 4) / 0.15, 9);
  });
});

describe('провайдер без 5-часового окна', () => {
  it('остаётся недельная траектория, X не считается', () => {
    const st = evaluateBudget(input({ u5h: null, r5h: null, u7d: 25 }), S);
    expect(st.available).toBeNull();
    expect(st.target).toBeCloseTo(18, 9);
    expect(st.deviation).toBeCloseTo(7, 9);
    expect(st.status).toBe('above');
    expect(st.windowExhaustsEarly).toBe(false);
  });
});

describe('режим «Отпуск»', () => {
  it('цели выключены полностью, проценты и сброс остаются', () => {
    const st = evaluateBudget(input({ mode: 'vacation', u5h: 40, u7d: 80 }), S);
    expect(st.status).toBe('off');
    expect(st.target).toBeNull();
    expect(st.deviation).toBeNull();
    expect(st.available).toBeNull();
    expect(st.exceeded).toBe(false);
    expect(st.usedWeek).toBe(80);
    expect(st.week.end).toBe(R7);
  });
});

describe('прогноз окна и остаток времени', () => {
  it('окно исчерпается раньше блока при текущей скорости', () => {
    // вторник 12:00, до конца блока 2 ч, осталось 40% окна, скорость 30 п.п./ч → 80 мин < 120 мин
    const st = evaluateBudget(input({ now: msk('2026-11-03', '12:00'), u5h: 60, r5h: msk('2026-11-03', '17:00'), rate5h: 30 }), S);
    expect(st.windowExhaustsEarly).toBe(true);
    expect(st.hoursToExhaust).toBeCloseTo(40 / 30, 9);
    const slow = evaluateBudget(input({ now: msk('2026-11-03', '12:00'), u5h: 60, r5h: msk('2026-11-03', '17:00'), rate5h: 10 }), S);
    expect(slow.windowExhaustsEarly).toBe(false);
  });

  it('если окно сбросится раньше исчерпания, тревоги нет', () => {
    const st = evaluateBudget(input({ now: msk('2026-11-03', '12:00'), u5h: 60, r5h: msk('2026-11-03', '12:30'), rate5h: 30 }), S);
    expect(st.windowExhaustsEarly).toBe(false);
  });

  it('H_left = (100 − u)/v и «не хватит»', () => {
    const st = evaluateBudget(input({ u7d: 60, speed7d: 2 }), S); // осталось 40 п.п. / 2 = 20 ч < 32 ч
    expect(st.hoursLeft).toBeCloseTo(20, 9);
    expect(st.remainingHours).toBeCloseTo(32, 9);
    expect(st.notEnough).toBe(true);
    expect(evaluateBudget(input({ u7d: 20, speed7d: 2 }), S).notEnough).toBe(false);
  });
});

describe('переход США на зимнее время 1 ноября 2026', () => {
  it('в пятницу 30 октября пик закрывает весь вечерний блок, в понедельник 2 ноября — с 16:00', () => {
    const base = { u7d: 10, r7d: msk('2026-11-06', '10:00') };
    const fri = evaluateBudget(input({ ...base, now: msk('2026-10-30', '15:05') }), S);
    expect(fri.peakNow).toBe(true);
    const mon = evaluateBudget(input({ ...base, now: msk('2026-11-02', '15:05') }), S);
    expect(mon.peakNow).toBe(false);
    const mon2 = evaluateBudget(input({ ...base, now: msk('2026-11-02', '16:05') }), S);
    expect(mon2.peakNow).toBe(true);
  });
});

describe('утро и вечер равны по весу', () => {
  it('блоки равного веса дают одинаковый прирост цели', () => {
    const week = weekWindow(msk('2026-11-03', '10:00'), R7, S.schedule);
    const t = (date: string, hm: string) => targetAt(S.schedule, week, msk(date, hm), 0.1)!;
    const morning = t('2026-11-03', '14:00') - t('2026-11-03', '10:00');
    const evening = t('2026-11-03', '19:00') - t('2026-11-03', '15:00');
    expect(morning).toBeCloseTo(evening, 9);
    expect(defaultSchedule().blocks.filter((b) => b.weekday === 1)).toHaveLength(2);
  });
});
