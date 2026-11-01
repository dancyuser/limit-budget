import { EventEmitter } from 'node:events';
import {
  DAY,
  HOUR,
  MINUTE,
  SignalEngine,
  attribute,
  buildTimeline,
  computeStats,
  dailySeries,
  detectAnomalies,
  estimateK,
  evaluateBudget,
  groupTicks,
  growthIntervals,
  kSamples,
  peakIntervals,
  rate5hAt,
  speed7d as computeSpeed7d,
  toZoned,
  windowDelta,
  type Anomaly,
  type AppMode,
  type BudgetState,
  type GrowthInterval,
  type KEstimate,
  type PeriodKind,
  type PeriodMode,
  type ProviderCapabilities,
  type ProviderId,
  type Schedule,
  type SignalEvent,
  type Snapshot,
  type Tick,
  type UsageProvider,
  type UsageStats,
} from '@limit-budget/core';
import type { Store, StoredAnomaly, StoredNote } from './db.js';
import { AuthRequiredError, PollTimeoutError, isTransientError } from './errors.js';
import { budgetSettings, mergeSettings, type AppSettings } from './settings.js';

export type ProviderStatus = 'ok' | 'stale' | 'needs-login' | 'error' | 'waiting' | 'disabled';

export interface ProviderView {
  id: ProviderId;
  label: string;
  enabled: boolean;
  capabilities: ProviderCapabilities;
  status: ProviderStatus;
  error: string | null;
  /** Сколько опросов подряд не удалось. */
  failures: number;
  /** Когда будет следующая попытка опроса, если последний сбой временный (нет связи, таймаут); иначе null. */
  retryAt: number | null;
  lastOkAt: number | null;
  tick: Tick | null;
  budget: BudgetState | null;
  k: KEstimate | null;
  rate5h: number | null;
  speed7d: number | null;
  currentModel: { model: string | null; effort: string | null } | null;
  openTask: { start: number; model: string | null; effort: string | null } | null;
}

export interface ViewState {
  now: number;
  mode: AppMode;
  peak: { now: boolean; label: string | null };
  providers: ProviderView[];
}

export interface ServiceEvents {
  state: [ViewState];
  signal: [{ provider: ProviderId; event: SignalEvent }];
  anomaly: [Anomaly];
  log: [string];
}

interface Runtime {
  provider: UsageProvider;
  ticks: Tick[];
  engine: SignalEngine;
  open: { id: number; iv: GrowthInterval; lastGrowthTs: number } | null;
  lastOkAt: number | null;
  error: string | null;
  needsLogin: boolean;
  failures: number;
  /** Последний сбой временный (связь, таймаут): повторять опрос скоро. */
  transient: boolean;
  growingNow: boolean;
  kEst: KEstimate | null;
  speed: number | null;
  lastKAt: number;
  lastSpeedAt: number;
  lastDetectAt: number;
  lastAggAt: number;
  lastPurgeAt: number;
  lastExtraAt: number;
  currentModel: { model: string | null; effort: string | null } | null;
  openTaskId: number | null;
}

/** Зависший источник не должен останавливать опрос остальных. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PollTimeoutError(message)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const POLL_TIMEOUT_MS = 30_000;
/** Паузы между повторами после временного сбоя связи, секунды; дальше действует обычный интервал опроса. */
export const RETRY_STEPS_SEC = [5, 10, 20, 30];
const LABELS: Record<ProviderId, string> = { claude: 'Claude', chatgpt: 'ChatGPT / Codex' };
const KEEP_TICKS_MS = 35 * DAY;

export interface ServiceOptions {
  store: Store;
  providers: UsageProvider[];
  clock?: () => number;
  /** Сколько ждать ответа источника, мс (по умолчанию 30 с). */
  pollTimeoutMs?: number;
  /** Вызывается после каждого неудачного опроса: приложение может сбросить соединения (например, после гибернации). */
  onFailure?: (provider: ProviderId, failures: number, transient: boolean) => void;
}

/** Опрос провайдеров, запись в базу, расчёт бюджета и сигналов. Не зависит от Electron. */
export class UsageService extends EventEmitter<ServiceEvents> {
  readonly store: Store;
  settings: AppSettings;
  schedule: Schedule;
  mode: AppMode;
  private clock: () => number;
  private pollTimeoutMs: number;
  private rt = new Map<ProviderId, Runtime>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private nextPollAt: number | null = null;
  private onFailure: ServiceOptions['onFailure'];

  constructor(opts: ServiceOptions) {
    super();
    this.store = opts.store;
    this.onFailure = opts.onFailure;
    this.clock = opts.clock ?? Date.now;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    this.settings = this.store.loadSettings();
    this.schedule = this.store.loadSchedule();
    this.mode = this.store.getMode();
    const now = this.clock();
    for (const provider of opts.providers) {
      this.rt.set(provider.id, {
        provider,
        ticks: this.store.getTicks(provider.id, now - KEEP_TICKS_MS, now),
        engine: new SignalEngine(this.settings.signals),
        open: null,
        lastOkAt: this.store.lastSnapshotTs(provider.id),
        error: null,
        needsLogin: false,
        failures: 0,
        transient: false,
        growingNow: false,
        kEst: null,
        speed: null,
        lastKAt: 0,
        lastSpeedAt: 0,
        lastDetectAt: 0,
        lastAggAt: 0,
        lastPurgeAt: 0,
        lastExtraAt: 0,
        currentModel: null,
        openTaskId: this.store.openTask(provider.id)?.id ?? null,
      });
      const last = this.store.getModelSamples(provider.id, now, now).at(-1);
      if (last) this.rt.get(provider.id)!.currentModel = { model: last.model, effort: last.effort };
    }
  }

  // --- жизненный цикл --------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextPollAt = null;
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextPollAt = null;
    const run = (async () => {
      try {
        await this.pollOnce();
      } catch (e) {
        this.emit('log', `poll loop: ${(e as Error).message}`);
      }
    })();
    this.inFlight = run;
    await run;
    if (this.inFlight === run) this.inFlight = null;
    if (!this.running) return;
    const { ms, retry } = this.nextDelay();
    this.nextPollAt = this.clock() + ms;
    this.timer = setTimeout(() => void this.loop(), ms);
    // Время повтора известно только сейчас: сообщаем интерфейсу, чтобы он показал «повтор через N с».
    if (retry) this.emit('state', this.getViewState());
  }

  /**
   * Пауза до следующего опроса. После временного сбоя связи повторяем скоро (5, 10, 20, 30 секунд), как мессенджеры при потере сети,
   * потом возвращаемся к обычному интервалу. Пока процент растёт, опрашиваем вдвое чаще: время работы по росту процента получается точнее.
   */
  private nextDelay(): { ms: number; retry: boolean } {
    const base = Math.max(10, this.settings.pollIntervalSec);
    const failing = [...this.rt.values()].filter((r) => r.transient && this.settings.providers[r.provider.id]?.enabled);
    if (failing.length) {
      const step = RETRY_STEPS_SEC[Math.max(...failing.map((r) => r.failures)) - 1];
      if (step !== undefined && step < base) return { ms: step * 1000, retry: true };
    }
    const growing = [...this.rt.values()].some((r) => r.growingNow);
    return { ms: (growing ? Math.max(10, Math.round(base / 2)) : base) * 1000, retry: false };
  }

  /**
   * Опросить сейчас, не дожидаясь таймера: кнопка «Обновить», пробуждение компьютера, возвращение сети.
   * Если опрос уже идёт, возвращает его же, а не запускает второй.
   */
  pollNow(): Promise<void> {
    if (!this.running) return this.pollOnce();
    return this.inFlight ?? this.loop();
  }

  /** Один круг опроса всех включённых провайдеров. Публичный: его же используют тесты и CLI. */
  async pollOnce(): Promise<void> {
    for (const rt of this.rt.values()) {
      if (!this.settings.providers[rt.provider.id]?.enabled) continue;
      await this.pollProvider(rt);
    }
    this.emit('state', this.getViewState());
  }

  private async pollProvider(rt: Runtime): Promise<void> {
    const now = this.clock();
    let newAnomalies: Anomaly[] = [];
    try {
      const snaps = await withTimeout(rt.provider.poll(), this.pollTimeoutMs, `источник не ответил за ${Math.round(this.pollTimeoutMs / 1000)} с`);
      const source = (rt.provider as { source?: string }).source ?? rt.provider.id;
      const rows: Snapshot[] = snaps.map((s) => ({
        ts: now,
        provider: rt.provider.id,
        window: s.window,
        bucket: s.bucket,
        usedPct: s.usedPct,
        resetsAt: s.resetsAt ? s.resetsAt.getTime() : null,
        source,
      }));
      if (rows.length) {
        this.store.insertSnapshots(rows);
        const tick = groupTicks(rows)[0];
        const prev = rt.ticks.at(-1) ?? null;
        rt.ticks.push(tick);
        const cutoff = now - KEEP_TICKS_MS;
        while (rt.ticks.length && rt.ticks[0].ts < cutoff) rt.ticks.shift();
        this.trackGrowth(rt, prev, tick);
      }
      rt.lastOkAt = now;
      rt.error = null;
      rt.needsLogin = false;
      rt.failures = 0;
      rt.transient = false;
      await this.syncExtras(rt, now);
    } catch (e) {
      rt.failures++;
      rt.transient = isTransientError(e);
      rt.growingNow = false;
      if (e instanceof AuthRequiredError) {
        rt.needsLogin = true;
        rt.error = 'нужен вход';
      } else {
        rt.error = (e as Error).message;
      }
      this.emit('log', `${rt.provider.id}: ${rt.error}`);
      try {
        this.onFailure?.(rt.provider.id, rt.failures, rt.transient);
      } catch (err) {
        this.emit('log', `onFailure: ${(err as Error).message}`);
      }
    }

    this.periodic(rt, now, (a) => (newAnomalies = a));
    const view = this.buildView(rt, now);
    if (view.budget && rt.ticks.length) {
      const last = rt.ticks.at(-1)!;
      const events = rt.engine.update({ now, budget: view.budget, r5h: last.r5h, newAnomalies });
      for (const event of events) this.emit('signal', { provider: rt.provider.id, event });
    }
  }

  // --- интервалы работы по росту процента -----------------------------------

  private trackGrowth(rt: Runtime, prev: Tick | null, cur: Tick): void {
    rt.growingNow = false;
    if (!prev) return;
    const d5 = windowDelta(prev.u5h, cur.u5h, prev.r5h, cur.r5h).delta;
    const d7 = windowDelta(prev.u7d, cur.u7d, prev.r7d, cur.r7d).delta;
    if (d5 <= 0 && d7 <= 0) return;
    rt.growingNow = true;
    const pause = this.settings.pauseThresholdMin * MINUTE;
    const start = Math.max(prev.ts, cur.ts - 2 * MINUTE);
    if (rt.open && start - rt.open.iv.end <= pause) {
      rt.open.iv.end = cur.ts;
      rt.open.iv.d5h += d5;
      rt.open.iv.d7d += d7;
      this.store.updateInterval(rt.open.id, rt.open.iv);
    } else {
      const iv: GrowthInterval = { start, end: cur.ts, d5h: d5, d7d: d7 };
      rt.open = { id: this.store.insertInterval(rt.provider.id, iv), iv, lastGrowthTs: cur.ts };
    }
  }

  // --- активность и задачи из провайдера (если умеет) -----------------------

  private async syncExtras(rt: Runtime, now: number): Promise<void> {
    if (now - rt.lastExtraAt < 5 * MINUTE) return;
    rt.lastExtraAt = now;
    const since = new Date(now - 2 * DAY);
    try {
      if (rt.provider.activity) {
        const rows = await rt.provider.activity(since);
        this.store.insertUsageEvents(
          rows.map((a) => ({ provider: rt.provider.id, ts: a.ts.getTime(), surface: a.surface, model: a.model, effort: a.effort, tokens: a.tokens })),
        );
      }
      if (rt.provider.tasks) {
        const known = this.store.getTasks(rt.provider.id, since.getTime(), now);
        for (const t of await rt.provider.tasks(since)) {
          const dup = known.some((k) => k.start === t.start.getTime() && k.source === (t.source ?? 'api'));
          if (dup) continue;
          const id = this.store.startTask({
            provider: rt.provider.id,
            surface: t.surface ?? null,
            start: t.start.getTime(),
            source: t.source ?? 'api',
            model: t.model ?? null,
            effort: t.effort ?? null,
          });
          if (t.end) this.store.endTask(id, t.end.getTime());
        }
      }
    } catch (e) {
      this.emit('log', `${rt.provider.id} extras: ${(e as Error).message}`);
    }
  }

  // --- периодические пересчёты ----------------------------------------------

  /** k и скорость расхода: нужны и онлайн, и в офлайн-режиме (CLI), поэтому вынесены отдельно. */
  private computeDerived(rt: Runtime, now: number): void {
    const bs = this.budget();
    if (now - rt.lastKAt >= 5 * MINUTE || rt.kEst === null) {
      const from = now - 14 * DAY;
      const recent = rt.ticks.filter((t) => t.ts >= from - HOUR);
      rt.kEst = estimateK(kSamples(recent, bs.peak), { now });
      rt.lastKAt = now;
    }
    if (now - rt.lastSpeedAt >= 10 * MINUTE || rt.speed === null) {
      rt.speed = computeSpeed7d(rt.ticks, bs, now);
      rt.lastSpeedAt = now;
    }
  }

  /** Пересчитать k и скорость по данным из базы без опроса провайдеров. */
  warmUp(): void {
    const now = this.clock();
    for (const rt of this.rt.values()) this.computeDerived(rt, now);
  }

  private periodic(rt: Runtime, now: number, onAnomalies: (a: Anomaly[]) => void): void {
    const bs = this.budget();
    this.computeDerived(rt, now);
    if (now - rt.lastDetectAt >= 30 * MINUTE) {
      rt.lastDetectAt = now;
      const found = detectAnomalies({ provider: rt.provider.id, ticks: rt.ticks, settings: bs, now });
      const fresh = found.filter((a) => this.store.addAnomaly(a, bs.schedule.tz));
      if (fresh.length) {
        onAnomalies(fresh);
        for (const a of fresh) this.emit('anomaly', a);
      }
    }
    if (now - rt.lastAggAt >= HOUR) {
      rt.lastAggAt = now;
      this.refreshAggregates(rt, now);
    }
    if (now - rt.lastPurgeAt >= DAY) {
      rt.lastPurgeAt = now;
      this.store.purgeRaw(now, this.settings.rawRetentionDays);
    }
  }

  /** Раскладка по моделям и режимам за последние сутки плюс дневные агрегаты. */
  refreshAggregates(rt: Runtime, now: number): void {
    const bs = this.budget();
    const tz = bs.schedule.tz;
    const from = now - 2 * DAY;
    const ticks = rt.ticks.filter((t) => t.ts >= from - HOUR);
    const intervals = growthIntervals(ticks, { pauseMs: this.settings.pauseThresholdMin * MINUTE });
    const timeline = buildTimeline({
      tasks: this.store.getTasks(rt.provider.id, from, now),
      samples: this.store.getModelSamples(rt.provider.id, from, now),
      now,
    });
    const byDay = new Map<string, GrowthInterval[]>();
    for (const iv of intervals) {
      const day = toZoned(iv.start + (iv.end - iv.start) / 2, tz).dateKey;
      byDay.set(day, [...(byDay.get(day) ?? []), iv]);
    }
    const days = [...byDay.keys()];
    const rows = days.flatMap((day) =>
      attribute(byDay.get(day)!, timeline).map((r) => ({
        provider: rt.provider.id,
        day,
        surface: r.surface,
        model: r.model,
        effort: r.effort,
        minutes: r.minutes,
        d5h: r.d5h,
        d7d: r.d7d,
      })),
    );
    if (days.length) this.store.replaceAttribution(rt.provider.id, days, rows);
    const series = dailySeries(ticks, tz, bs.schedule, from, now);
    this.store.upsertDailyAggregates(
      series.map((d) => ({
        provider: rt.provider.id,
        day: d.date,
        gain5h: d.gain5h,
        gain7d: d.gain7d,
        workHours: d.workHours,
        growthMinutes: (byDay.get(d.date) ?? []).reduce((s, iv) => s + (iv.end - iv.start) / MINUTE, 0),
      })),
    );
  }

  // --- состояние для интерфейса ---------------------------------------------

  budget() {
    return budgetSettings(this.settings, this.schedule);
  }

  private buildView(rt: Runtime, now: number): ProviderView {
    const id = rt.provider.id;
    const enabled = !!this.settings.providers[id]?.enabled;
    const last = rt.ticks.at(-1) ?? null;
    const staleAfter = Math.max(3 * this.settings.pollIntervalSec * 1000, 5 * MINUTE);
    const stale = rt.lastOkAt === null || now - rt.lastOkAt > staleAfter;
    const rate5h = rt.ticks.length ? rate5hAt(rt.ticks, rt.ticks.length - 1) : null;
    let budget: BudgetState | null = null;
    if (last && enabled) {
      budget = evaluateBudget(
        {
          now,
          mode: this.mode,
          u5h: last.u5h,
          r5h: last.r5h,
          u7d: last.u7d,
          r7d: last.r7d,
          k: rt.kEst,
          rate5h,
          speed7d: rt.speed,
          stale,
        },
        this.budget(),
      );
    }
    let status: ProviderStatus = 'ok';
    if (!enabled) status = 'disabled';
    else if (rt.needsLogin) status = 'needs-login';
    else if (!last) status = rt.error ? 'error' : 'waiting';
    else if (stale) status = 'stale';
    else if (rt.error) status = 'error';
    const task = rt.openTaskId !== null ? this.store.openTask(id) : null;
    return {
      id,
      label: LABELS[id],
      enabled,
      capabilities: rt.provider.capabilities,
      status,
      error: rt.error,
      failures: rt.failures,
      retryAt: rt.transient && this.running ? this.nextPollAt : null,
      lastOkAt: rt.lastOkAt,
      tick: last,
      budget,
      k: rt.kEst,
      rate5h,
      speed7d: rt.speed,
      currentModel: rt.currentModel,
      openTask: task ? { start: task.start, model: task.model, effort: task.effort } : null,
    };
  }

  getViewState(): ViewState {
    const now = this.clock();
    const bs = this.budget();
    const nowPeak = peakIntervals(bs.peak, now, now + 1).length > 0;
    const next = peakIntervals(bs.peak, now - DAY, now + 2 * DAY).find((iv) => iv.end > now);
    const fmt = (ms: number) => {
      const z = toZoned(ms, bs.schedule.tz);
      return `${String(Math.floor(z.minutesOfDay / 60)).padStart(2, '0')}:${String(z.minutesOfDay % 60).padStart(2, '0')}`;
    };
    return {
      now,
      mode: this.mode,
      peak: { now: nowPeak, label: next ? `${fmt(next.start)}–${fmt(next.end)}` : null },
      providers: [...this.rt.values()].map((rt) => this.buildView(rt, now)),
    };
  }

  /** Пересчитать и разослать состояние без опроса (после смены настроек, режима и т. п.). */
  refresh(): void {
    this.emit('state', this.getViewState());
  }

  // --- команды ---------------------------------------------------------------

  setMode(mode: AppMode): void {
    this.mode = mode;
    this.store.setMode(mode, this.clock());
    this.refresh();
  }

  updateSettings(patch: unknown): AppSettings {
    this.settings = mergeSettings(this.settings, patch);
    this.store.saveSettings(this.settings);
    for (const rt of this.rt.values()) {
      rt.engine.config = this.settings.signals;
      rt.lastKAt = 0;
      rt.lastSpeedAt = 0;
    }
    this.refresh();
    return this.settings;
  }

  setSchedule(s: Schedule): void {
    this.schedule = s;
    this.store.saveSchedule(s);
    for (const rt of this.rt.values()) rt.lastSpeedAt = 0;
    this.refresh();
  }

  setModel(provider: ProviderId, model: string | null, effort: string | null, surface = 'chat'): void {
    const rt = this.rt.get(provider);
    if (!rt) return;
    rt.currentModel = { model, effort };
    this.store.insertModelSample({ ts: this.clock(), provider, surface, model, effort, source: 'manual' });
    this.refresh();
  }

  startTask(provider: ProviderId): void {
    const rt = this.rt.get(provider);
    if (!rt || rt.openTaskId !== null) return;
    rt.openTaskId = this.store.startTask({
      provider,
      surface: 'chat',
      start: this.clock(),
      source: 'manual',
      model: rt.currentModel?.model ?? null,
      effort: rt.currentModel?.effort ?? null,
    });
    this.refresh();
  }

  stopTask(provider: ProviderId): void {
    const rt = this.rt.get(provider);
    if (!rt || rt.openTaskId === null) return;
    this.store.endTask(rt.openTaskId, this.clock());
    rt.openTaskId = null;
    this.refresh();
  }

  addNote(text: string, provider: ProviderId | null = null): void {
    this.store.addNote(this.clock(), text, provider);
  }

  notes(): StoredNote[] {
    return this.store.listNotes();
  }

  anomalies(): StoredAnomaly[] {
    return this.store.listAnomalies();
  }

  /** Статистика за период по данным из базы. */
  getStats(provider: ProviderId, kind: PeriodKind, mode: PeriodMode): UsageStats {
    const now = this.clock();
    const bs = this.budget();
    const from = now - 62 * DAY;
    return computeStats({
      ticks: this.store.getTicks(provider, from, now),
      tasks: this.store.getTasks(provider, from, now),
      samples: this.store.getModelSamples(provider, from, now),
      settings: bs,
      kind,
      mode,
      now,
      vacations: this.store.vacationRanges(),
      pauseMs: this.settings.pauseThresholdMin * MINUTE,
    });
  }

  runtimeOf(id: ProviderId): Runtime | undefined {
    return this.rt.get(id);
  }
}
