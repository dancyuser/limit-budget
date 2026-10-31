import { describe, expect, it } from 'vitest';
import {
  MINUTE,
  attribute,
  buildTimeline,
  taskTime,
  type GrowthInterval,
  type ModelSample,
  type TaskRecord,
} from '../src/index.js';
import { msk } from './helpers.js';

const at = (hm: string) => msk('2026-11-03', hm);
const iv = (a: string, b: string, d5h: number, d7d: number): GrowthInterval => ({ start: at(a), end: at(b), d5h, d7d });
const sample = (hm: string, model: string, effort: string | null): ModelSample => ({
  ts: at(hm),
  provider: 'claude',
  surface: 'chat',
  model,
  effort,
  source: 'manual',
});
const task = (a: string, b: string | null, model: string, effort: string | null): TaskRecord => ({
  provider: 'claude',
  surface: 'chat',
  start: at(a),
  end: b ? at(b) : null,
  source: 'manual',
  model,
  effort,
});

describe('раскладка прироста по модели и режиму', () => {
  const sum = (rows: ReturnType<typeof attribute>, f: 'd5h' | 'd7d' | 'minutes') => rows.reduce((s, r) => s + r[f], 0);

  it('на размеченном дне сумма долей по моделям равна приросту процента', () => {
    const samples = [sample('10:00', 'opus', 'extended'), sample('11:30', 'sonnet', null), sample('13:00', 'opus', null)];
    const timeline = buildTimeline({ tasks: [], samples, now: at('19:00') });
    const intervals = [iv('10:10', '10:50', 12, 1.8), iv('11:20', '11:50', 6, 0.9), iv('12:40', '13:20', 8, 1.2), iv('15:00', '15:30', 5, 0.7)];
    const rows = attribute(intervals, timeline);
    expect(sum(rows, 'd5h')).toBeCloseTo(31, 9);
    expect(sum(rows, 'd7d')).toBeCloseTo(4.6, 9);
    expect(sum(rows, 'minutes')).toBeCloseTo(40 + 30 + 40 + 30, 9);
    const opusExt = rows.find((r) => r.model === 'opus' && r.effort === 'extended')!;
    expect(opusExt.d5h).toBeCloseTo(12 + 2, 9); // 10:10–10:50 целиком и 10 из 30 минут интервала 11:20–11:50
    expect(rows.find((r) => r.model === 'sonnet')!.d5h).toBeCloseTo(4 + 4, 9);
    expect(rows.find((r) => r.model === 'opus' && r.effort === null)!.d5h).toBeCloseTo(4 + 5, 9);
    expect(rows.some((r) => r.model === 'unknown')).toBe(false);
  });

  it('интервал, пересекающий границу, делится пропорционально времени', () => {
    const timeline = buildTimeline({
      tasks: [],
      samples: [sample('10:00', 'opus', null), sample('10:30', 'sonnet', null)],
      now: at('12:00'),
    });
    const rows = attribute([iv('10:20', '10:40', 10, 1)], timeline);
    const opus = rows.find((r) => r.model === 'opus')!;
    const sonnet = rows.find((r) => r.model === 'sonnet')!;
    expect(opus.d5h).toBeCloseTo(5, 9);
    expect(sonnet.d5h).toBeCloseTo(5, 9);
  });

  it('неразмеченное время уходит в unknown, а итог сохраняется', () => {
    const timeline = buildTimeline({ tasks: [], samples: [sample('10:00', 'opus', null)], now: at('12:00') });
    const rows = attribute([iv('09:50', '10:10', 8, 1)], timeline);
    const unknown = rows.find((r) => r.model === 'unknown')!;
    expect(unknown.estimated).toBe(true);
    expect(unknown.d5h).toBeCloseTo(4, 9);
    expect(sum(rows, 'd5h')).toBeCloseTo(8, 9);
    expect(sum(rows, 'd7d')).toBeCloseTo(1, 9);
  });

  it('без разметки весь прирост попадает в unknown', () => {
    const rows = attribute([iv('10:00', '10:10', 3, 0.5)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('unknown');
    expect(rows[0].d5h).toBeCloseTo(3, 9);
  });

  it('задача важнее отметки модели там, где они пересекаются', () => {
    const timeline = buildTimeline({
      tasks: [task('10:10', '10:30', 'opus', 'extended')],
      samples: [sample('10:00', 'sonnet', null)],
      now: at('12:00'),
    });
    const rows = attribute([iv('10:00', '10:40', 12, 1.2)], timeline);
    expect(rows.find((r) => r.model === 'opus')!.d5h).toBeCloseTo(6, 9);
    expect(rows.find((r) => r.model === 'sonnet')!.d5h).toBeCloseTo(6, 9);
    expect(sum(rows, 'd5h')).toBeCloseTo(12, 9);
  });

  it('интервал нулевой длины относится к сегменту, в который попадает', () => {
    const timeline = buildTimeline({ tasks: [], samples: [sample('10:00', 'opus', null)], now: at('12:00') });
    const rows = attribute([{ start: at('10:05'), end: at('10:05'), d5h: 2, d7d: 0.3 }], timeline);
    expect(rows[0].model).toBe('opus');
  });
});

describe('время выполнения задач', () => {
  it('считаются только завершённые задачи, незавершённая — после окончания', () => {
    const rows = taskTime([task('10:00', '10:20', 'opus', 'extended'), task('11:00', null, 'opus', 'extended')], at('00:00'), at('23:00'));
    expect(rows).toHaveLength(1);
    expect(rows[0].minutes).toBeCloseTo(20, 9);
    expect(rows[0].count).toBe(1);
    expect(MINUTE).toBe(60_000);
  });
});
