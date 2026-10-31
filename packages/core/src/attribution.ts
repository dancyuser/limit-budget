import { MINUTE } from './time.js';
import type { GrowthInterval, ModelSample, TaskRecord } from './types.js';

/** Отрезок времени, на котором известны модель и режим рассуждений. */
export interface ContextSegment {
  start: number;
  end: number;
  model: string | null;
  effort: string | null;
  surface: string | null;
  source: string;
  priority: number;
}

export interface TimelineInput {
  tasks: TaskRecord[];
  samples: ModelSample[];
  now: number;
  /** Сколько автоматическая отметка модели считается действующей без новых отметок. */
  sampleHoldMs?: number;
  /** Ручная отметка действует до следующей отметки, но не дольше этого срока. */
  manualHoldMs?: number;
}

const TASK_PRIORITY = 2;
const SAMPLE_PRIORITY = 1;

/**
 * Единая раскладка времени по моделям. Задачи точнее отметок (у них известны начало и конец),
 * поэтому там, где они пересекаются, побеждает задача.
 */
export function buildTimeline(input: TimelineInput): ContextSegment[] {
  const autoHold = input.sampleHoldMs ?? 5 * MINUTE;
  const manualHold = input.manualHoldMs ?? 12 * 60 * MINUTE;
  const raw: ContextSegment[] = [];
  for (const t of input.tasks) {
    if (!t.model && !t.effort) continue;
    raw.push({
      start: t.start,
      end: t.end ?? input.now,
      model: t.model,
      effort: t.effort,
      surface: t.surface,
      source: t.source,
      priority: TASK_PRIORITY,
    });
  }
  const samples = input.samples.filter((s) => s.model || s.effort).sort((a, b) => a.ts - b.ts);
  samples.forEach((s, i) => {
    const next = samples[i + 1]?.ts ?? Infinity;
    const hold = s.source === 'manual' ? manualHold : autoHold;
    raw.push({
      start: s.ts,
      end: Math.min(next, s.ts + hold, input.now),
      model: s.model,
      effort: s.effort,
      surface: s.surface,
      source: s.source,
      priority: SAMPLE_PRIORITY,
    });
  });
  return resolve(raw.filter((r) => r.end > r.start));
}

function resolve(segments: ContextSegment[]): ContextSegment[] {
  const bounds = [...new Set(segments.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const out: ContextSegment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    let best: ContextSegment | null = null;
    for (const s of segments) {
      if (s.start <= a && s.end >= b && (!best || s.priority > best.priority || (s.priority === best.priority && s.start > best.start))) {
        best = s;
      }
    }
    if (!best) continue;
    const prev = out[out.length - 1];
    if (prev && prev.end === a && sameContext(prev, best) && prev.priority === best.priority) prev.end = b;
    else out.push({ ...best, start: a, end: b });
  }
  return out;
}

function sameContext(a: ContextSegment, b: ContextSegment): boolean {
  return a.model === b.model && a.effort === b.effort && a.surface === b.surface && a.source === b.source;
}

export const UNKNOWN_MODEL = 'unknown';

export interface AttributionRow {
  model: string;
  effort: string | null;
  surface: string | null;
  /** Время работы по росту процента, минут. */
  minutes: number;
  d5h: number;
  d7d: number;
  /** true, если строка получена не из размеченных данных (модель не определена). */
  estimated: boolean;
}

function key(model: string, effort: string | null, surface: string | null): string {
  return `${model}\u0000${effort ?? ''}\u0000${surface ?? ''}`;
}

/**
 * Раскладка прироста процента по модели и режиму. Прирост интервала делится пропорционально времени,
 * неразмеченная часть уходит в «unknown», поэтому сумма долей всегда равна общему приросту.
 */
export function attribute(intervals: GrowthInterval[], timeline: ContextSegment[]): AttributionRow[] {
  const rows = new Map<string, AttributionRow>();
  const add = (model: string | null, effort: string | null, surface: string | null, ms: number, d5: number, d7: number) => {
    const m = model ?? UNKNOWN_MODEL;
    const k = key(m, effort, surface);
    let r = rows.get(k);
    if (!r) {
      r = { model: m, effort, surface, minutes: 0, d5h: 0, d7d: 0, estimated: m === UNKNOWN_MODEL };
      rows.set(k, r);
    }
    r.minutes += ms / MINUTE;
    r.d5h += d5;
    r.d7d += d7;
  };

  for (const iv of intervals) {
    const dur = iv.end - iv.start;
    if (dur <= 0) {
      const seg = timeline.find((s) => s.start <= iv.end && iv.end <= s.end);
      add(seg?.model ?? null, seg?.effort ?? null, seg?.surface ?? null, 0, iv.d5h, iv.d7d);
      continue;
    }
    let covered = 0;
    for (const seg of timeline) {
      const ov = Math.min(iv.end, seg.end) - Math.max(iv.start, seg.start);
      if (ov <= 0) continue;
      covered += ov;
      const share = ov / dur;
      add(seg.model, seg.effort, seg.surface, ov, iv.d5h * share, iv.d7d * share);
    }
    const rest = dur - covered;
    if (rest > 1e-6) add(null, null, null, rest, iv.d5h * (rest / dur), iv.d7d * (rest / dur));
  }
  return [...rows.values()].sort((a, b) => b.d7d - a.d7d || b.minutes - a.minutes);
}

export interface TaskTimeRow {
  model: string;
  effort: string | null;
  surface: string | null;
  minutes: number;
  count: number;
}

/** Время выполнения завершённых задач по модели и режиму; незавершённая задача учитывается после окончания. */
export function taskTime(tasks: TaskRecord[], from: number, to: number): TaskTimeRow[] {
  const rows = new Map<string, TaskTimeRow>();
  for (const t of tasks) {
    if (t.end === null || t.end < from || t.start > to) continue;
    const ms = Math.min(t.end, to) - Math.max(t.start, from);
    if (ms <= 0) continue;
    const model = t.model ?? UNKNOWN_MODEL;
    const k = key(model, t.effort, t.surface);
    let r = rows.get(k);
    if (!r) {
      r = { model, effort: t.effort, surface: t.surface, minutes: 0, count: 0 };
      rows.set(k, r);
    }
    r.minutes += ms / MINUTE;
    r.count += 1;
  }
  return [...rows.values()];
}
