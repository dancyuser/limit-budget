import { DAY, HOUR, MINUTE, toZoned } from './time.js';
import { isPeak, type PeakProfile } from './peak.js';
import { blockAt, type Schedule } from './schedule.js';
import type {
  ProviderCapabilities,
  Tick,
  UsageProvider,
  WindowSnapshot,
} from './types.js';

/** Детерминированный генератор для воспроизводимых тестов и демо. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimOptions {
  start: number;
  /** Момент сброса недельного лимита (первый); дальше каждые 7 суток. */
  weekResetsAt: number;
  schedule: Schedule;
  peak: PeakProfile;
  seed?: number;
  /** Сколько п.п. недели съедает 1 п.п. 5-часового окна вне пика и в пике. */
  kOffpeak?: number;
  kPeak?: number;
  /** Расход 5-часового процента за минуту активной работы, п.п. */
  ratePerActiveMinute?: number;
  /** Доля рабочего времени, когда пользователь действительно общается с моделью. */
  activeShare?: number;
  /** Множитель расхода 5-часового процента в заданные часы суток по поясу расписания (для проверки детектора). */
  heavyHours?: { fromTs: number; hours: number[]; factor: number };
  /** Множитель недельного расхода с момента (имитация уменьшения недельного лимита). */
  weeklyShift?: { fromTs: number; factor: number };
  /** Округление выдаваемых процентов; 0 — без округления. */
  decimals?: number;
}

/** Простой симулятор расхода: работа в блоках расписания, 5-часовое окно открывается с первого сообщения. */
export class UsageSimulator {
  u5h = 0;
  r5h: number | null = null;
  u7d = 0;
  r7d: number;
  ts: number;
  private rnd: () => number;
  private active = false;

  constructor(private o: SimOptions) {
    this.ts = o.start;
    this.r7d = o.weekResetsAt;
    this.rnd = mulberry32(o.seed ?? 1);
  }

  /** Продвигает время поминутно до `to` и возвращает тики на каждую минуту. */
  advance(to: number, stepMs = MINUTE): Tick[] {
    const ticks: Tick[] = [];
    while (this.ts + stepMs <= to) {
      this.ts += stepMs;
      this.tickOnce(stepMs);
      ticks.push(this.snapshot());
    }
    return ticks;
  }

  snapshot(): Tick {
    const d = this.o.decimals ?? 1;
    const r = (v: number) => (d === 0 ? v : Math.round(v * 10 ** d) / 10 ** d);
    return { ts: this.ts, u5h: r(this.u5h), r5h: this.r5h, u7d: r(this.u7d), r7d: this.r7d };
  }

  private tickOnce(stepMs: number): void {
    const t = this.ts;
    if (this.r5h !== null && t >= this.r5h) {
      this.u5h = 0;
      this.r5h = null;
    }
    while (t >= this.r7d) {
      this.r7d += 7 * DAY;
      this.u7d = 0;
    }
    if (!blockAt(this.o.schedule, t)) {
      this.active = false;
      return;
    }
    // Рабочие всплески: переключение «пишет / думает» с инерцией.
    const share = this.o.activeShare ?? 0.6;
    if (this.rnd() < (this.active ? 0.9 : 0.1 * (share / (1 - share)))) this.active = true;
    else this.active = false;
    if (!this.active) return;
    const minutes = stepMs / MINUTE;
    const base5 = (this.o.ratePerActiveMinute ?? 0.2) * minutes * (0.6 + 0.8 * this.rnd());
    const k = isPeak(this.o.peak, t) ? (this.o.kPeak ?? 0.1) : (this.o.kOffpeak ?? 0.15);
    let d7 = base5 * k;
    let d5 = base5;
    // «Тяжёлый час»: 5-часовой процент уходит быстрее, недельный по тем же запросам остаётся прежним.
    const hv = this.o.heavyHours;
    if (hv && t >= hv.fromTs) {
      const hour = Math.floor(toZoned(t, this.o.schedule.tz).minutesOfDay / 60);
      if (hv.hours.includes(hour)) d5 *= hv.factor;
    }
    const ws = this.o.weeklyShift;
    if (ws && t >= ws.fromTs) d7 *= ws.factor;
    if (this.r5h === null) this.r5h = t + 5 * HOUR;
    this.u5h = Math.min(100, this.u5h + d5);
    this.u7d = Math.min(100, this.u7d + d7);
  }
}

/** История тиков за период — для тестов, демо-режима и проверки детектора. */
export function simulateHistory(o: SimOptions, to: number, stepMs = MINUTE): Tick[] {
  return new UsageSimulator(o).advance(to, stepMs);
}

const CLAUDE_CAPS: ProviderCapabilities = {
  windows: ['5h', '7d'],
  surfaces: ['chat'],
  modelBreakdown: false,
  effort: false,
};

/** Провайдер для тестов и демо: отдаёт то, что вернёт переданная функция. */
export class FakeProvider implements UsageProvider {
  id: UsageProvider['id'];
  capabilities: ProviderCapabilities;
  calls = 0;

  constructor(
    private produce: () => WindowSnapshot[] | Promise<WindowSnapshot[]>,
    opts: { id?: UsageProvider['id']; capabilities?: ProviderCapabilities } = {},
  ) {
    this.id = opts.id ?? 'claude';
    this.capabilities = opts.capabilities ?? CLAUDE_CAPS;
  }

  async poll(): Promise<WindowSnapshot[]> {
    this.calls++;
    return this.produce();
  }

  /** Провайдер на базе симулятора: каждый опрос продвигает время до clock(). */
  static simulated(sim: UsageSimulator, clock: () => number): FakeProvider {
    return new FakeProvider(() => {
      sim.advance(clock());
      const t = sim.snapshot();
      return tickToSnapshots(t);
    });
  }
}

export function tickToSnapshots(t: Tick): WindowSnapshot[] {
  const out: WindowSnapshot[] = [];
  if (t.u5h !== null) out.push({ window: '5h', bucket: 'all', usedPct: t.u5h, resetsAt: t.r5h === null ? null : new Date(t.r5h) });
  if (t.u7d !== null) out.push({ window: '7d', bucket: 'all', usedPct: t.u7d, resetsAt: t.r7d === null ? null : new Date(t.r7d) });
  return out;
}
