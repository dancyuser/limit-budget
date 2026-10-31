import type { Tick, UsageStats } from '@limit-budget/core';

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
}

const iso = (ms: number | null) => (ms === null ? '' : new Date(ms).toISOString());

export function snapshotsCsv(ticks: Tick[]): string {
  return toCsv(
    ['ts_utc', 'used_5h', 'resets_5h_utc', 'used_7d', 'resets_7d_utc', 'sonnet_7d', 'opus_7d'],
    ticks.map((t) => [iso(t.ts), t.u5h, iso(t.r5h), t.u7d, iso(t.r7d), t.sonnet7d ?? null, t.opus7d ?? null]),
  );
}

export function daysCsv(s: UsageStats): string {
  return toCsv(
    ['date', 'gain_5h', 'gain_7d', 'work_hours', 'growth_minutes', 'vacation', 'deviation_end'],
    s.days.map((d) => [d.date, d.gain5h, d.gain7d, d.workHours, d.growthMinutes, d.vacation ? 1 : 0, d.deviationEnd]),
  );
}

export function modelsCsv(s: UsageStats): string {
  return toCsv(
    ['model', 'effort', 'surface', 'growth_minutes', 'task_minutes', 'task_count', 'delta_5h', 'delta_7d', 'pct5h_per_hour', 'pct7d_per_hour', 'estimated'],
    s.models.map((m) => [m.model, m.effort, m.surface, m.growthMinutes, m.taskMinutes, m.taskCount, m.d5h, m.d7d, m.pct5hPerHour, m.pct7dPerHour, m.estimated ? 1 : 0]),
  );
}

export function blocksCsv(s: UsageStats): string {
  return toCsv(
    ['date', 'block', 'start', 'end', 'available_start', 'available_end', 'deviation_start', 'deviation_end', 'gain_5h', 'gain_7d'],
    s.blocks.map((b) => [
      b.date,
      b.index === 0 ? 'morning' : 'evening',
      iso(b.start),
      iso(b.end),
      b.availableStart,
      b.availableEnd,
      b.deviationStart,
      b.deviationEnd,
      b.gain5h,
      b.gain7d,
    ]),
  );
}
