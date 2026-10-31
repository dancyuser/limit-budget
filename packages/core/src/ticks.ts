import { MINUTE, median } from './time.js';
import { isPeak, type PeakProfile } from './peak.js';
import type { GrowthInterval, Snapshot, Tick } from './types.js';

/** Склеивает построчные снимки в тики: по одному на момент опроса. */
export function groupTicks(snapshots: Snapshot[]): Tick[] {
  const byTs = new Map<number, Tick>();
  for (const s of snapshots) {
    let t = byTs.get(s.ts);
    if (!t) {
      t = { ts: s.ts, u5h: null, r5h: null, u7d: null, r7d: null };
      byTs.set(s.ts, t);
    }
    if (s.bucket === 'all') {
      if (s.window === '5h') {
        t.u5h = s.usedPct;
        t.r5h = s.resetsAt;
      } else {
        t.u7d = s.usedPct;
        t.r7d = s.resetsAt;
      }
    } else if (s.window === '7d') {
      if (s.bucket === 'sonnet') t.sonnet7d = s.usedPct;
      if (s.bucket === 'opus') t.opus7d = s.usedPct;
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

const RESET_JUMP = MINUTE; // resetsAt сдвинулся вперёд больше чем на минуту — окно сменилось

/** Прирост между двумя соседними значениями с учётом сброса окна. */
export function windowDelta(
  prevU: number | null,
  curU: number | null,
  prevR: number | null,
  curR: number | null,
): { delta: number; reset: boolean } {
  if (curU === null) return { delta: 0, reset: false };
  if (prevU === null) return { delta: 0, reset: false };
  const jumped = prevR !== null && curR !== null && curR - prevR > RESET_JUMP;
  const dropped = curU < prevU;
  if (jumped || dropped) return { delta: curU, reset: true };
  return { delta: curU - prevU, reset: false };
}

export interface GrowthOptions {
  /** Склеиваем соседние всплески роста, если пауза между ними не длиннее. */
  pauseMs?: number;
  /** Сколько времени до снимка с ростом считается работой, если опрос стоял дольше. */
  maxEventMs?: number;
}

/** Интервалы работы по росту процента: подряд идущие снимки с ростом склеиваются, если пауза короткая. */
export function growthIntervals(ticks: Tick[], opts: GrowthOptions = {}): GrowthInterval[] {
  const pauseMs = opts.pauseMs ?? 3 * MINUTE;
  const maxEventMs = opts.maxEventMs ?? 2 * MINUTE;
  const out: GrowthInterval[] = [];
  let cur: GrowthInterval | null = null;
  for (let i = 1; i < ticks.length; i++) {
    const p = ticks[i - 1];
    const t = ticks[i];
    const d5 = windowDelta(p.u5h, t.u5h, p.r5h, t.r5h).delta;
    const d7 = windowDelta(p.u7d, t.u7d, p.r7d, t.r7d).delta;
    if (d5 <= 0 && d7 <= 0) continue;
    const start = Math.max(p.ts, t.ts - maxEventMs);
    if (cur && start - cur.end <= pauseMs) {
      cur.end = t.ts;
      cur.d5h += d5;
      cur.d7d += d7;
    } else {
      if (cur) out.push(cur);
      cur = { start, end: t.ts, d5h: d5, d7d: d7 };
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface KSample {
  ts: number;
  d5h: number;
  d7d: number;
  peak: boolean;
}

export interface KOptions {
  /** Минимальный прирост 5-часового процента для одной пары: защита от округления. */
  minD5h?: number;
  /** Минимальный прирост недельного процента: пара закрывается между двумя «ступеньками» недельного счётчика. */
  minD7d?: number;
  /** Если опрос стоял дольше, накопление начинается заново. */
  maxGapMs?: number;
}

/**
 * Пары для коэффициента k = Δ7d / Δ5h. Прирост копится с «якорной» точки, пока не наберётся порог по обоим окнам:
 * проценты приходят округлёнными, и отношение по соседним снимкам было бы почти всегда нулевым.
 * Пара, которая захватила начало или конец пикового режима, отбрасывается.
 */
export function kSamples(ticks: Tick[], peak: PeakProfile, opts: KOptions = {}): KSample[] {
  const minD5h = opts.minD5h ?? 2;
  const minD7d = opts.minD7d ?? 1;
  const maxGap = opts.maxGapMs ?? 15 * MINUTE;
  const out: KSample[] = [];
  let anchorTs: number | null = null;
  let acc5 = 0;
  let acc7 = 0;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (t.u5h === null || t.u7d === null) {
      anchorTs = null;
      continue;
    }
    const p = ticks[i - 1];
    if (anchorTs === null || !p || t.ts - p.ts > maxGap || p.u5h === null || p.u7d === null) {
      anchorTs = t.ts;
      acc5 = 0;
      acc7 = 0;
      continue;
    }
    acc5 += windowDelta(p.u5h, t.u5h, p.r5h, t.r5h).delta;
    acc7 += windowDelta(p.u7d, t.u7d, p.r7d, t.r7d).delta;
    if (acc5 >= minD5h && acc7 >= minD7d) {
      if (isPeak(peak, anchorTs) === isPeak(peak, t.ts)) {
        out.push({ ts: t.ts, d5h: acc5, d7d: acc7, peak: isPeak(peak, t.ts) });
      }
      anchorTs = t.ts;
      acc5 = 0;
      acc7 = 0;
    }
  }
  return out;
}

export interface KEstimate {
  peak: number | null;
  offpeak: number | null;
  nPeak: number;
  nOffpeak: number;
}

/** Медиана отношения прироста недельного процента к приросту 5-часового, отдельно для пика и вне его. */
export function estimateK(
  samples: KSample[],
  opts: { now?: number; windowDays?: number; minSamples?: number } = {},
): KEstimate {
  const minSamples = opts.minSamples ?? 5;
  const from = opts.now !== undefined ? opts.now - (opts.windowDays ?? 14) * 86_400_000 : -Infinity;
  const within = samples.filter((s) => s.ts >= from && s.d5h > 0);
  const ratio = (list: KSample[]) => (list.length >= minSamples ? median(list.map((s) => s.d7d / s.d5h)) : null);
  const peak = within.filter((s) => s.peak);
  const off = within.filter((s) => !s.peak);
  return { peak: ratio(peak), offpeak: ratio(off), nPeak: peak.length, nOffpeak: off.length };
}
