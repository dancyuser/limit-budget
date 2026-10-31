// Локальная база SQLite (встроенный node:sqlite — без нативных зависимостей).
// Хранятся только счётчики и метаданные; тексты разговоров не читаются и не сохраняются.
// Время хранится в UTC (epoch ms), расписание задано в своём поясе.
import { DatabaseSync } from 'node:sqlite';
import {
  defaultSchedule,
  groupTicks,
  toZoned,
  type Anomaly,
  type AppMode,
  type Bucket,
  type GrowthInterval,
  type ModelSample,
  type ProviderId,
  type Schedule,
  type ScheduleBlock,
  type Snapshot,
  type TaskRecord,
  type TaskSource,
  type Tick,
  type WindowName,
} from '@limit-budget/core';
import { loadSettings, type AppSettings } from './settings.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS limit_snapshot (
  ts INTEGER NOT NULL, provider TEXT NOT NULL, window TEXT NOT NULL, bucket TEXT NOT NULL,
  used_pct REAL NOT NULL, resets_at INTEGER, source TEXT NOT NULL,
  PRIMARY KEY (provider, ts, window, bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS activity_interval (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, surface TEXT,
  start INTEGER NOT NULL, "end" INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'inferred',
  model TEXT, effort TEXT, d5h REAL NOT NULL DEFAULT 0, d7d REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_activity_start ON activity_interval (provider, start);

CREATE TABLE IF NOT EXISTS task_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, surface TEXT,
  start INTEGER NOT NULL, "end" INTEGER, source TEXT NOT NULL, model TEXT, effort TEXT
);
CREATE INDEX IF NOT EXISTS ix_task_start ON task_run (provider, start);

CREATE TABLE IF NOT EXISTS model_sample (
  ts INTEGER NOT NULL, provider TEXT NOT NULL, surface TEXT, model TEXT, effort TEXT, source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_model_sample_ts ON model_sample (provider, ts);

CREATE TABLE IF NOT EXISTS attribution (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, day TEXT NOT NULL, surface TEXT,
  model TEXT NOT NULL, effort TEXT, minutes REAL NOT NULL, delta_5h REAL NOT NULL, delta_7d REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attribution_day ON attribution (provider, day);

CREATE TABLE IF NOT EXISTS schedule (
  weekday INTEGER NOT NULL, start TEXT NOT NULL, "end" TEXT NOT NULL, weight REAL NOT NULL, tz TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_exception (date TEXT PRIMARY KEY, type TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS mode_state (mode TEXT NOT NULL, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provider_config (provider TEXT PRIMARY KEY, enabled INTEGER NOT NULL, json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS event_note (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anomaly (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, window TEXT NOT NULL,
  kind TEXT NOT NULL, ratio REAL NOT NULL, note TEXT, day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_anomaly_ts ON anomaly (provider, ts);

-- Зарезервировано под адаптеры на логах, прежде всего Codex.
CREATE TABLE IF NOT EXISTS usage_event (
  provider TEXT NOT NULL, ts INTEGER NOT NULL, surface TEXT, model TEXT, effort TEXT, tokens INTEGER
);
CREATE INDEX IF NOT EXISTS ix_usage_event_ts ON usage_event (provider, ts);
CREATE TABLE IF NOT EXISTS ingest_cursor (provider TEXT NOT NULL, file TEXT NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY (provider, file));

-- Дневные агрегаты хранятся бессрочно.
CREATE TABLE IF NOT EXISTS daily_aggregate (
  provider TEXT NOT NULL, day TEXT NOT NULL, gain_5h REAL NOT NULL, gain_7d REAL NOT NULL,
  work_hours REAL NOT NULL, growth_minutes REAL NOT NULL, PRIMARY KEY (provider, day)
) WITHOUT ROWID;
`;

export interface StoredNote {
  id: number;
  ts: number;
  provider: ProviderId | null;
  text: string;
}

export interface StoredAnomaly extends Anomaly {
  id: number;
}

export interface DailyAggregate {
  provider: ProviderId;
  day: string;
  gain5h: number;
  gain7d: number;
  workHours: number;
  growthMinutes: number;
}

export interface AttributionRecord {
  provider: ProviderId;
  day: string;
  surface: string | null;
  model: string;
  effort: string | null;
  minutes: number;
  d5h: number;
  d7d: number;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // --- limit_snapshot --------------------------------------------------------

  insertSnapshots(rows: Snapshot[]): void {
    const st = this.db.prepare(
      'INSERT OR REPLACE INTO limit_snapshot (ts, provider, window, bucket, used_pct, resets_at, source) VALUES (?,?,?,?,?,?,?)',
    );
    this.tx(() => {
      for (const r of rows) st.run(r.ts, r.provider, r.window, r.bucket, r.usedPct, r.resetsAt, r.source);
    });
  }

  getSnapshots(provider: ProviderId, from = 0, to = Number.MAX_SAFE_INTEGER): Snapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM limit_snapshot WHERE provider = ? AND ts >= ? AND ts <= ? ORDER BY ts')
      .all(provider, from, to) as Row[];
    return rows.map((r) => ({
      ts: num(r.ts),
      provider: r.provider as ProviderId,
      window: r.window as WindowName,
      bucket: r.bucket as Bucket,
      usedPct: num(r.used_pct),
      resetsAt: numOrNull(r.resets_at),
      source: String(r.source),
    }));
  }

  getTicks(provider: ProviderId, from = 0, to = Number.MAX_SAFE_INTEGER): Tick[] {
    return groupTicks(this.getSnapshots(provider, from, to));
  }

  lastSnapshotTs(provider: ProviderId): number | null {
    const r = this.db.prepare('SELECT MAX(ts) AS ts FROM limit_snapshot WHERE provider = ?').get(provider) as Row;
    return numOrNull(r.ts);
  }

  // --- activity_interval -----------------------------------------------------

  insertInterval(provider: ProviderId, iv: GrowthInterval, surface: string | null = null): number {
    const r = this.db
      .prepare('INSERT INTO activity_interval (provider, surface, start, "end", d5h, d7d) VALUES (?,?,?,?,?,?)')
      .run(provider, surface, iv.start, iv.end, iv.d5h, iv.d7d);
    return Number(r.lastInsertRowid);
  }

  updateInterval(id: number, iv: GrowthInterval): void {
    this.db.prepare('UPDATE activity_interval SET "end" = ?, d5h = ?, d7d = ? WHERE id = ?').run(iv.end, iv.d5h, iv.d7d, id);
  }

  getIntervals(provider: ProviderId, from: number, to: number): GrowthInterval[] {
    const rows = this.db
      .prepare('SELECT start, "end", d5h, d7d FROM activity_interval WHERE provider = ? AND "end" >= ? AND start <= ? ORDER BY start')
      .all(provider, from, to) as Row[];
    return rows.map((r) => ({ start: num(r.start), end: num(r.end), d5h: num(r.d5h), d7d: num(r.d7d) }));
  }

  // --- task_run --------------------------------------------------------------

  startTask(t: { provider: ProviderId; surface?: string | null; start: number; source: TaskSource; model?: string | null; effort?: string | null }): number {
    const r = this.db
      .prepare('INSERT INTO task_run (provider, surface, start, "end", source, model, effort) VALUES (?,?,?,?,?,?,?)')
      .run(t.provider, t.surface ?? null, t.start, null, t.source, t.model ?? null, t.effort ?? null);
    return Number(r.lastInsertRowid);
  }

  endTask(id: number, end: number): void {
    this.db.prepare('UPDATE task_run SET "end" = ? WHERE id = ?').run(end, id);
  }

  openTask(provider: ProviderId): (TaskRecord & { id: number }) | null {
    const r = this.db
      .prepare('SELECT * FROM task_run WHERE provider = ? AND "end" IS NULL ORDER BY start DESC LIMIT 1')
      .get(provider) as Row | undefined;
    return r ? { id: num(r.id), ...this.toTask(r) } : null;
  }

  getTasks(provider: ProviderId, from: number, to: number): TaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM task_run WHERE provider = ? AND start <= ? AND (COALESCE("end", ?) >= ?) ORDER BY start')
      .all(provider, to, to, from) as Row[];
    return rows.map((r) => this.toTask(r));
  }

  private toTask(r: Row): TaskRecord {
    return {
      provider: r.provider as ProviderId,
      surface: strOrNull(r.surface),
      start: num(r.start),
      end: numOrNull(r.end),
      source: r.source as TaskSource,
      model: strOrNull(r.model),
      effort: strOrNull(r.effort),
    };
  }

  // --- model_sample ----------------------------------------------------------

  insertModelSample(s: ModelSample): void {
    this.db
      .prepare('INSERT INTO model_sample (ts, provider, surface, model, effort, source) VALUES (?,?,?,?,?,?)')
      .run(s.ts, s.provider, s.surface, s.model, s.effort, s.source);
  }

  getModelSamples(provider: ProviderId, from: number, to: number): ModelSample[] {
    // Берём и последнюю отметку до начала периода: она действует и внутри периода.
    const prior = this.db
      .prepare('SELECT * FROM model_sample WHERE provider = ? AND ts < ? ORDER BY ts DESC LIMIT 1')
      .all(provider, from) as Row[];
    const rows = this.db
      .prepare('SELECT * FROM model_sample WHERE provider = ? AND ts >= ? AND ts <= ? ORDER BY ts')
      .all(provider, from, to) as Row[];
    return [...prior, ...rows].map((r) => ({
      ts: num(r.ts),
      provider: r.provider as ProviderId,
      surface: strOrNull(r.surface),
      model: strOrNull(r.model),
      effort: strOrNull(r.effort),
      source: String(r.source),
    }));
  }

  // --- attribution / daily_aggregate ----------------------------------------

  replaceAttribution(provider: ProviderId, days: string[], rows: AttributionRecord[]): void {
    this.tx(() => {
      const del = this.db.prepare('DELETE FROM attribution WHERE provider = ? AND day = ?');
      for (const d of days) del.run(provider, d);
      const ins = this.db.prepare(
        'INSERT INTO attribution (provider, day, surface, model, effort, minutes, delta_5h, delta_7d) VALUES (?,?,?,?,?,?,?,?)',
      );
      for (const r of rows) ins.run(r.provider, r.day, r.surface, r.model, r.effort, r.minutes, r.d5h, r.d7d);
    });
  }

  getAttribution(provider: ProviderId, fromDay: string, toDay: string): AttributionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM attribution WHERE provider = ? AND day >= ? AND day <= ? ORDER BY day')
      .all(provider, fromDay, toDay) as Row[];
    return rows.map((r) => ({
      provider: r.provider as ProviderId,
      day: String(r.day),
      surface: strOrNull(r.surface),
      model: String(r.model),
      effort: strOrNull(r.effort),
      minutes: num(r.minutes),
      d5h: num(r.delta_5h),
      d7d: num(r.delta_7d),
    }));
  }

  upsertDailyAggregates(rows: DailyAggregate[]): void {
    const st = this.db.prepare(
      'INSERT OR REPLACE INTO daily_aggregate (provider, day, gain_5h, gain_7d, work_hours, growth_minutes) VALUES (?,?,?,?,?,?)',
    );
    this.tx(() => {
      for (const r of rows) st.run(r.provider, r.day, r.gain5h, r.gain7d, r.workHours, r.growthMinutes);
    });
  }

  getDailyAggregates(provider: ProviderId, fromDay: string, toDay: string): DailyAggregate[] {
    const rows = this.db
      .prepare('SELECT * FROM daily_aggregate WHERE provider = ? AND day >= ? AND day <= ? ORDER BY day')
      .all(provider, fromDay, toDay) as Row[];
    return rows.map((r) => ({
      provider: r.provider as ProviderId,
      day: String(r.day),
      gain5h: num(r.gain_5h),
      gain7d: num(r.gain_7d),
      workHours: num(r.work_hours),
      growthMinutes: num(r.growth_minutes),
    }));
  }

  // --- расписание ------------------------------------------------------------

  loadSchedule(): Schedule {
    const rows = this.db.prepare('SELECT weekday, start, "end", weight, tz FROM schedule ORDER BY weekday, start').all() as Row[];
    if (rows.length === 0) return defaultSchedule();
    const blocks: ScheduleBlock[] = rows.map((r) => ({
      weekday: num(r.weekday),
      start: String(r.start),
      end: String(r.end),
      weight: num(r.weight),
    }));
    const exceptions = (this.db.prepare('SELECT date, type FROM schedule_exception ORDER BY date').all() as Row[]).map((r) => ({
      date: String(r.date),
      type: r.type as 'off' | 'work',
    }));
    return { tz: String(rows[0].tz), blocks, exceptions };
  }

  saveSchedule(s: Schedule): void {
    this.tx(() => {
      this.db.exec('DELETE FROM schedule; DELETE FROM schedule_exception;');
      const ins = this.db.prepare('INSERT INTO schedule (weekday, start, "end", weight, tz) VALUES (?,?,?,?,?)');
      for (const b of s.blocks) ins.run(b.weekday, b.start, b.end, b.weight, s.tz);
      const exc = this.db.prepare('INSERT INTO schedule_exception (date, type) VALUES (?,?)');
      for (const e of s.exceptions) exc.run(e.date, e.type);
    });
  }

  // --- режим «Работа / Отпуск» ----------------------------------------------

  getMode(): AppMode {
    const r = this.db.prepare('SELECT mode FROM mode_state ORDER BY since DESC, rowid DESC LIMIT 1').get() as Row | undefined;
    return (r?.mode as AppMode | undefined) ?? 'work';
  }

  setMode(mode: AppMode, since: number): void {
    if (this.getMode() === mode && this.modeHistory().length > 0) return;
    this.db.prepare('INSERT INTO mode_state (mode, since) VALUES (?,?)').run(mode, since);
  }

  modeHistory(): Array<{ mode: AppMode; since: number }> {
    const rows = this.db.prepare('SELECT mode, since FROM mode_state ORDER BY since, rowid').all() as Row[];
    return rows.map((r) => ({ mode: r.mode as AppMode, since: num(r.since) }));
  }

  /** Периоды отпуска для пометки в статистике. */
  vacationRanges(): Array<{ from: number; to: number | null }> {
    const out: Array<{ from: number; to: number | null }> = [];
    let open: number | null = null;
    for (const h of this.modeHistory()) {
      if (h.mode === 'vacation' && open === null) open = h.since;
      if (h.mode === 'work' && open !== null) {
        out.push({ from: open, to: h.since });
        open = null;
      }
    }
    if (open !== null) out.push({ from: open, to: null });
    return out;
  }

  // --- настройки -------------------------------------------------------------

  loadSettings(): AppSettings {
    const r = this.db.prepare("SELECT json FROM settings WHERE key = 'app'").get() as Row | undefined;
    return loadSettings(r ? JSON.parse(String(r.json)) : undefined);
  }

  saveSettings(s: AppSettings): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, json) VALUES ('app', ?)").run(JSON.stringify(s));
    const st = this.db.prepare('INSERT OR REPLACE INTO provider_config (provider, enabled, json) VALUES (?,?,?)');
    for (const [id, cfg] of Object.entries(s.providers)) st.run(id, cfg.enabled ? 1 : 0, JSON.stringify(cfg));
  }

  // --- служебные метки (например, «стартовые события уже занесены») -----------

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT json FROM settings WHERE key = ?').get(`meta:${key}`) as Row | undefined;
    return r ? String(r.json) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, json) VALUES (?, ?)').run(`meta:${key}`, value);
  }

  // --- ручные пометки и аномалии --------------------------------------------

  addNote(ts: number, text: string, provider: ProviderId | null = null): number {
    const r = this.db.prepare('INSERT INTO event_note (ts, provider, text) VALUES (?,?,?)').run(ts, provider, text);
    return Number(r.lastInsertRowid);
  }

  deleteNote(id: number): void {
    this.db.prepare('DELETE FROM event_note WHERE id = ?').run(id);
  }

  listNotes(limit = 200): StoredNote[] {
    const rows = this.db.prepare('SELECT * FROM event_note ORDER BY ts DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => ({
      id: num(r.id),
      ts: num(r.ts),
      provider: strOrNull(r.provider) as ProviderId | null,
      text: String(r.text),
    }));
  }

  /** Записывает аномалию, если за этот день такой же (provider, window, kind) ещё не записывался. */
  addAnomaly(a: Anomaly, dayTz: string): boolean {
    const day = toZoned(a.ts, dayTz).dateKey;
    const dup = this.db
      .prepare('SELECT 1 AS x FROM anomaly WHERE provider = ? AND window = ? AND kind = ? AND day = ?')
      .get(a.provider, a.window, a.kind, day);
    if (dup) return false;
    this.db
      .prepare('INSERT INTO anomaly (ts, provider, window, kind, ratio, note, day) VALUES (?,?,?,?,?,?,?)')
      .run(a.ts, a.provider, a.window, a.kind, a.ratio, a.note ?? null, day);
    return true;
  }

  listAnomalies(limit = 200): StoredAnomaly[] {
    const rows = this.db.prepare('SELECT * FROM anomaly ORDER BY ts DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => ({
      id: num(r.id),
      ts: num(r.ts),
      provider: r.provider as ProviderId,
      window: r.window as WindowName,
      kind: r.kind as Anomaly['kind'],
      ratio: num(r.ratio),
      note: strOrNull(r.note) ?? undefined,
    }));
  }

  // --- usage_event / ingest_cursor (заготовка под Codex) ---------------------

  insertUsageEvents(
    rows: Array<{ provider: ProviderId; ts: number; surface?: string; model?: string; effort?: string; tokens?: number }>,
  ): void {
    const st = this.db.prepare('INSERT INTO usage_event (provider, ts, surface, model, effort, tokens) VALUES (?,?,?,?,?,?)');
    this.tx(() => {
      for (const r of rows) st.run(r.provider, r.ts, r.surface ?? null, r.model ?? null, r.effort ?? null, r.tokens ?? null);
    });
  }

  getCursor(provider: ProviderId, file: string): number {
    const r = this.db.prepare('SELECT offset FROM ingest_cursor WHERE provider = ? AND file = ?').get(provider, file) as Row | undefined;
    return r ? num(r.offset) : 0;
  }

  setCursor(provider: ProviderId, file: string, offset: number): void {
    this.db.prepare('INSERT OR REPLACE INTO ingest_cursor (provider, file, offset) VALUES (?,?,?)').run(provider, file, offset);
  }

  // --- хранение --------------------------------------------------------------

  /** Сырая активность хранится rawRetentionDays, снимки и дневные агрегаты бессрочно. Возвращает число удалённых строк. */
  purgeRaw(now: number, days: number): number {
    const cutoff = now - days * 86_400_000;
    let n = 0;
    for (const sql of [
      'DELETE FROM activity_interval WHERE "end" < ?',
      'DELETE FROM model_sample WHERE ts < ?',
      'DELETE FROM task_run WHERE COALESCE("end", start) < ?',
      'DELETE FROM usage_event WHERE ts < ?',
    ]) {
      n += Number(this.db.prepare(sql).run(cutoff).changes);
    }
    return n;
  }
}
