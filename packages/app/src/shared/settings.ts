import {
  SIGNAL_KINDS,
  defaultPeakProfile,
  defaultSignalConfig,
  type BudgetSettings,
  type PeakProfile,
  type ProviderId,
  type Schedule,
  type SignalConfig,
  type SignalKind,
} from '@limit-budget/core';

/** Встроенные тоны (синтезируются в окне виджета) либо путь к своему файлу. */
export type SoundId = 'warning' | 'exceeded' | 'soft' | 'tick' | 'change' | 'none';

export interface SoundChoice {
  sound: SoundId;
  /** Свой звуковой файл имеет приоритет над встроенным тоном. */
  file?: string;
}

export interface SoundSettings {
  muted: boolean;
  /** 0..1 */
  volume: number;
  perKind: Record<SignalKind, SoundChoice>;
}

export interface WidgetBounds {
  x: number;
  y: number;
  /** id монитора, на котором стоял виджет: при смене монитора позиция возвращается в видимую область. */
  displayId?: number;
}

export interface WidgetSettings {
  expanded: boolean;
  opacity: number;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  bounds?: WidgetBounds;
}

export interface ProviderConfig {
  enabled: boolean;
}

export interface AppSettings {
  reserve: number;
  deviationPct: number;
  lowAvailablePct: number;
  manualK: number | null;
  peak: PeakProfile;
  pollIntervalSec: number;
  /** Пауза, короче которой всплески роста процента склеиваются в один интервал работы. */
  pauseThresholdMin: number;
  signals: SignalConfig;
  sounds: SoundSettings;
  notifications: boolean;
  providers: Record<ProviderId, ProviderConfig>;
  widget: WidgetSettings;
  startWithWindows: boolean;
  /** Запасной путь входа: взять сессию из хранилища Claude Desktop. Выключено, пока явно не включено. */
  desktopSessionFallback: boolean;
  /** Сколько дней хранить сырую активность; снимки и дневные агрегаты хранятся бессрочно. */
  rawRetentionDays: number;
  /** Организация claude.ai, найденная при первом входе. */
  claudeOrgId: string | null;
  /** Прокси для сетевых запросов: пусто — системный, `off` — без прокси, `10808` или `socks5://127.0.0.1:10808`. Ключ запуска --proxy важнее. */
  proxy: string | null;
}

const SOUND_DEFAULTS: Record<SignalKind, SoundChoice> = {
  'over-trajectory': { sound: 'warning' },
  'limit-exceeded': { sound: 'exceeded' },
  'window-ends-early': { sound: 'warning' },
  'low-available': { sound: 'warning' },
  'window-reset': { sound: 'soft' },
  'peak-start': { sound: 'tick' },
  'peak-end': { sound: 'tick' },
  'limits-changed': { sound: 'change' },
};

export function defaultSettings(): AppSettings {
  return {
    reserve: 0.1,
    deviationPct: 5,
    lowAvailablePct: 5,
    manualK: 0.15,
    peak: defaultPeakProfile(),
    pollIntervalSec: 60,
    pauseThresholdMin: 3,
    signals: defaultSignalConfig(),
    sounds: { muted: false, volume: 0.6, perKind: structuredClone(SOUND_DEFAULTS) },
    notifications: true,
    providers: { claude: { enabled: true }, chatgpt: { enabled: false } },
    widget: { expanded: false, opacity: 0.96, clickThrough: false, alwaysOnTop: true },
    startWithWindows: false,
    desktopSessionFallback: false,
    rawRetentionDays: 90,
    claudeOrgId: null,
    proxy: null,
  };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Глубокое слияние: значения из patch заменяют значения по умолчанию, неизвестные ключи не теряются. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : (patch as T));
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(out[k]) && isObj(v) ? mergeSettings(out[k], v) : v;
  }
  return out as T;
}

export function loadSettings(stored: unknown): AppSettings {
  const merged = mergeSettings(defaultSettings(), stored);
  // Защита от устаревших настроек: все сигналы и звуки должны быть описаны.
  for (const k of SIGNAL_KINDS) {
    merged.signals.enabled[k] ??= defaultSignalConfig().enabled[k];
    merged.sounds.perKind[k] ??= SOUND_DEFAULTS[k];
  }
  merged.sounds.volume = Math.min(1, Math.max(0, merged.sounds.volume));
  return merged;
}

export function budgetSettings(s: AppSettings, schedule: Schedule): BudgetSettings {
  return {
    reserve: s.reserve,
    deviationPct: s.deviationPct,
    lowAvailablePct: s.lowAvailablePct,
    manualK: s.manualK,
    schedule,
    peak: s.peak,
  };
}
