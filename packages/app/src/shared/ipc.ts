import type {
  AppMode,
  PeriodKind,
  PeriodMode,
  ProviderId,
  Schedule,
  SignalEvent,
  UsageStats,
} from '@limit-budget/core';
import type { StoredAnomaly, StoredNote } from './db.js';
import type { ViewState } from './service.js';
import type { AppSettings, SoundChoice } from './settings.js';

export interface SignalPayload {
  provider: ProviderId;
  event: SignalEvent;
  sound: SoundChoice;
  volume: number;
  muted: boolean;
}

export interface ProxyInfo {
  /** Что задано: строка из ключа запуска, окружения или настроек. */
  raw: string;
  source: 'launch' | 'env' | 'settings';
  /** Человекочитаемый вид: socks5://127.0.0.1:10808, «без прокси» или «системный». */
  display: string;
  /** Что реально выбирает Chromium для https://claude.ai (например, «SOCKS5 127.0.0.1:10808» или «DIRECT»). */
  resolved: string;
  /** Ключ запуска или окружение перекрывают значение из настроек. */
  overridesSettings: boolean;
}

export interface ProxyTestResult {
  /** Получен любой HTTP-ответ от claude.ai через выбранный путь. */
  reachable: boolean;
  status?: number;
  ms: number;
  resolved: string;
  /** Страна выхода по данным Cloudflare (двухбуквенный код); IP-адрес не сохраняется и не показывается. */
  country?: string;
  error?: string;
  /** Доходит ли тем же путём Google (вход через Google идёт на accounts.google.com). */
  google?: { reachable: boolean; status?: number; ms: number; error?: string };
  /** Открытые окна claude.ai и путь, который выбирает каждое (адрес — только хост). */
  windows?: Array<{ kind: string; host: string; proxy: string }>;
}

export interface LoginResult {
  ok: boolean;
  message: string;
  /** Cloudflare просит проверку: нужна страница claude.ai в окне приложения. */
  cloudflare?: boolean;
}

export interface SpikeResult {
  file: string;
  summary: string[];
}

/** Интерфейс, который preload отдаёт страницам виджета и дашборда. */
export interface Api {
  getState(): Promise<ViewState>;
  /** Опросить сейчас; если с данными что-то не так, сначала сбрасывает застарелые соединения. */
  refresh(): Promise<void>;
  onState(cb: (s: ViewState) => void): () => void;
  onSignal(cb: (s: SignalPayload) => void): () => void;
  /** Главное окно просит открыть вкладку, например `settings:proxy`. */
  onTab(cb: (target: string) => void): () => void;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: unknown): Promise<AppSettings>;
  getSchedule(): Promise<Schedule>;
  setSchedule(s: Schedule): Promise<void>;
  setMode(mode: AppMode): Promise<void>;
  getStats(provider: ProviderId, kind: PeriodKind, mode: PeriodMode): Promise<UsageStats>;
  listNotes(): Promise<StoredNote[]>;
  addNote(text: string, provider: ProviderId | null): Promise<void>;
  deleteNote(id: number): Promise<void>;
  listAnomalies(): Promise<StoredAnomaly[]>;
  setModel(provider: ProviderId, model: string | null, effort: string | null): Promise<void>;
  startTask(provider: ProviderId): Promise<void>;
  stopTask(provider: ProviderId): Promise<void>;
  /** Главный способ входа: открывает окно claude.ai, вход обнаруживается автоматически, окно закрывается само. */
  openLogin(): Promise<void>;
  login: {
    importSessionKey(text: string): Promise<LoginResult>;
    openClaudeInBrowser(): Promise<void>;
    openInApp(): Promise<void>;
    openPage(): Promise<void>;
    /** Запасной способ, если автоматический вход не подошёл (например, Cloudflare). */
    openHelp(): Promise<void>;
    /** Тихо берёт сессию из установленного Claude Desktop, если он есть. */
    tryDesktop(): Promise<LoginResult>;
  };
  openDashboard(tab?: string): Promise<void>;
  runSpike(): Promise<SpikeResult>;
  /** Открыть в проводнике папку с настройками, базой и отчётами шага 0. */
  openDataFolder(): Promise<void>;
  getProxy(): Promise<ProxyInfo>;
  testProxy(): Promise<ProxyTestResult>;
  testSound(kind: string): Promise<void>;
  exportData(provider: ProviderId, what: 'snapshots' | 'days' | 'models', format: 'csv' | 'json', period: PeriodKind, mode: PeriodMode): Promise<string | null>;
  pickSoundFile(): Promise<string | null>;
  widget: {
    dragStart(): void;
    dragMove(dx: number, dy: number): void;
    dragEnd(): void;
    setSize(width: number, height: number): void;
    setExpanded(expanded: boolean): Promise<void>;
    hide(): void;
  };
  isDemo: boolean;
}

declare global {
  interface Window {
    api: Api;
  }
}
