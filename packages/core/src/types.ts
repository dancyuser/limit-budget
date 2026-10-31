// Общие типы ядра. Никаких зависимостей от Electron и Node.

export type ProviderId = 'claude' | 'chatgpt';
/** 5h — пятичасовое окно, 7d — недельный лимит. */
export type WindowName = '5h' | '7d';
/** Срез недельного лимита: все модели или отдельная модель. */
export type Bucket = 'all' | 'sonnet' | 'opus';

// --- Контракт провайдера (раздел «Архитектура» плана) -----------------------

/** Что вернул провайдер за один опрос. Окна необязательны: у Codex на части тарифов нет 5-часового. */
export interface WindowSnapshot {
  window: WindowName;
  bucket: Bucket;
  usedPct: number;
  resetsAt: Date | null;
}

export interface ActivitySample {
  ts: Date;
  surface?: string;
  model?: string;
  effort?: string;
  tokens?: number;
}

export type TaskSource = 'api' | 'ui_automation' | 'debug_port' | 'rollout' | 'manual';

export interface TaskRun {
  start: Date;
  /** null — задача ещё идёт, учитывается после окончания. */
  end: Date | null;
  surface?: string;
  model?: string;
  effort?: string;
  source?: TaskSource;
}

export interface ProviderCapabilities {
  windows: WindowName[];
  surfaces: string[];
  modelBreakdown: boolean;
  effort: boolean;
}

export interface UsageProvider {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  poll(): Promise<WindowSnapshot[]>;
  activity?(since: Date): Promise<ActivitySample[]>;
  tasks?(since: Date): Promise<TaskRun[]>;
}

// --- Внутренние записи (время — epoch ms, UTC) ------------------------------

/** Строка таблицы limit_snapshot. */
export interface Snapshot {
  ts: number;
  provider: ProviderId;
  window: WindowName;
  bucket: Bucket;
  usedPct: number;
  resetsAt: number | null;
  source: string;
}

/** Снимок одного опроса: оба окна «all» на одном ts. */
export interface Tick {
  ts: number;
  u5h: number | null;
  r5h: number | null;
  u7d: number | null;
  r7d: number | null;
  /** Недельные срезы по моделям, если тариф их отдаёт. */
  sonnet7d?: number | null;
  opus7d?: number | null;
}

/** Строка таблицы activity_interval: интервал роста процента. */
export interface GrowthInterval {
  start: number;
  end: number;
  d5h: number;
  d7d: number;
}

/** Строка task_run (внутренний вид). */
export interface TaskRecord {
  provider: ProviderId;
  surface: string | null;
  start: number;
  end: number | null;
  source: TaskSource;
  model: string | null;
  effort: string | null;
}

/** Строка model_sample. */
export interface ModelSample {
  ts: number;
  provider: ProviderId;
  surface: string | null;
  model: string | null;
  effort: string | null;
  source: string;
}

export type AnomalyKind = 'peak' | 'drop' | 'step';

export interface Anomaly {
  ts: number;
  provider: ProviderId;
  window: WindowName;
  kind: AnomalyKind;
  ratio: number;
  /** Поясняющий текст для журнала. */
  note?: string;
}

export type AppMode = 'work' | 'vacation';
