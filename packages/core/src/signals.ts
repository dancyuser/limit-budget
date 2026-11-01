import { MINUTE } from './time.js';
import type { BudgetState } from './budget.js';
import type { Anomaly } from './types.js';

export type SignalKind =
  | 'over-trajectory' // расход выше траектории больше чем на δ
  | 'limit-exceeded' // «доступно сейчас» упало до нуля или недельный расход дошёл до цели
  | 'window-ends-early' // 5-часовое окно исчерпается раньше конца блока
  | 'low-available' // «доступно сейчас» близко к нулю
  | 'window-reset' // окно сброшено или открыто новое
  | 'peak-start'
  | 'peak-end'
  | 'limits-changed'; // детектор нашёл возможное изменение лимитов

export type SignalSeverity = 'exceeded' | 'warning' | 'quiet' | 'info';

export const SIGNAL_META: Record<SignalKind, { severity: SignalSeverity; label: string; defaultEnabled: boolean }> = {
  'over-trajectory': { severity: 'warning', label: 'Расход выше траектории', defaultEnabled: true },
  'limit-exceeded': { severity: 'exceeded', label: 'Лимит превышен', defaultEnabled: true },
  'window-ends-early': { severity: 'warning', label: 'Окно закончится раньше блока', defaultEnabled: true },
  'low-available': { severity: 'warning', label: 'Доступно почти ноль', defaultEnabled: true },
  'window-reset': { severity: 'quiet', label: 'Окно сброшено', defaultEnabled: false },
  'peak-start': { severity: 'quiet', label: 'Начало пиковых часов', defaultEnabled: false },
  'peak-end': { severity: 'quiet', label: 'Конец пиковых часов', defaultEnabled: false },
  'limits-changed': { severity: 'info', label: 'Возможное изменение лимитов', defaultEnabled: true },
};

export const SIGNAL_KINDS = Object.keys(SIGNAL_META) as SignalKind[];

export interface SignalConfig {
  enabled: Record<SignalKind, boolean>;
  /** Повторное напоминание, пока условие не снято; 0 — не напоминать. */
  reminderMinutes: number;
  /** Сколько условие должно быть снято, прежде чем сигнал снова «взведётся»: защита от дребезга у порога. */
  rearmMinutes: number;
}

export function defaultSignalConfig(): SignalConfig {
  const enabled = {} as Record<SignalKind, boolean>;
  for (const k of SIGNAL_KINDS) enabled[k] = SIGNAL_META[k].defaultEnabled;
  return { enabled, reminderMinutes: 20, rearmMinutes: 5 };
}

export interface SignalEvent {
  kind: SignalKind;
  severity: SignalSeverity;
  ts: number;
  message: string;
  reminder: boolean;
}

export interface SignalContext {
  now: number;
  budget: BudgetState;
  /** Момент сброса 5-часового окна из последнего опроса — для события «окно сброшено». */
  r5h: number | null;
  newAnomalies?: Anomaly[];
}

interface CondState {
  active: boolean;
  lastFired: number;
  clearedSince: number | null;
}

const fmtPct = (n: number) => `${Math.round(n * 10) / 10}`;

/**
 * Сигналы срабатывают один раз за пересечение порога; повторные напоминания идут не чаще заданного интервала.
 * В режиме «Отпуск» и при устаревших данных сигналов нет вовсе.
 */
export class SignalEngine {
  private states = new Map<SignalKind, CondState>();
  private lastR5h: number | null | undefined;
  private lastPeak: boolean | undefined;

  constructor(public config: SignalConfig = defaultSignalConfig()) {}

  update(ctx: SignalContext): SignalEvent[] {
    const b = ctx.budget;
    if (b.mode === 'vacation' || b.stale) {
      // Базовые значения для событий-переходов обновляем молча, чтобы после отпуска не прозвучал лишний сигнал.
      this.lastR5h = ctx.r5h;
      this.lastPeak = b.peakNow;
      return [];
    }
    const out: SignalEvent[] = [];
    const emit = (kind: SignalKind, message: string, reminder = false) => {
      if (!this.config.enabled[kind]) return;
      out.push({ kind, severity: SIGNAL_META[kind].severity, ts: ctx.now, message, reminder });
    };

    const conditions: Array<[SignalKind, boolean, string]> = [
      [
        'over-trajectory',
        b.status === 'above',
        `Недельный расход выше траектории на ${fmtPct(b.deviation ?? 0)} п.п.`,
      ],
      [
        'limit-exceeded',
        b.exceeded,
        b.u5hEffective !== null && b.u5hEffective >= 100
          ? '5-часовое окно израсходовано: «доступно сейчас» = 0'
          : 'Недельный расход дошёл до цели',
      ],
      [
        'window-ends-early',
        b.windowExhaustsEarly,
        `5-часовое окно закончится раньше блока (через ${fmtPct((b.hoursToExhaust ?? 0) * 60)} мин)`,
      ],
      [
        'low-available',
        b.lowAvailable && !b.exceeded && b.block?.inBlock === true,
        `«Доступно сейчас» почти исчерпано: ${fmtPct(b.available ?? 0)}%`,
      ],
    ];
    for (const [kind, cond, message] of conditions) this.edge(kind, cond, message, ctx.now, emit);

    // События-переходы.
    if (this.lastR5h !== undefined && ctx.r5h !== null && this.lastR5h !== null && ctx.r5h - this.lastR5h > MINUTE) {
      emit('window-reset', 'Окно сброшено, открыто новое');
    }
    this.lastR5h = ctx.r5h;
    if (this.lastPeak !== undefined && this.lastPeak !== b.peakNow) {
      emit(b.peakNow ? 'peak-start' : 'peak-end', b.peakNow ? 'Начались пиковые часы' : 'Пиковые часы закончились');
    }
    this.lastPeak = b.peakNow;
    for (const a of ctx.newAnomalies ?? []) {
      emit('limits-changed', a.note ?? `Возможное изменение лимитов (${a.kind}, ×${fmtPct(a.ratio)})`);
    }
    return out;
  }

  private edge(
    kind: SignalKind,
    cond: boolean,
    message: string,
    now: number,
    emit: (k: SignalKind, m: string, reminder?: boolean) => void,
  ): void {
    let st = this.states.get(kind);
    if (!st) {
      st = { active: false, lastFired: 0, clearedSince: null };
      this.states.set(kind, st);
    }
    if (cond) {
      st.clearedSince = null;
      if (!st.active) {
        st.active = true;
        st.lastFired = now;
        emit(kind, message);
      } else if (this.config.reminderMinutes > 0 && now - st.lastFired >= this.config.reminderMinutes * MINUTE) {
        st.lastFired = now;
        emit(kind, message, true);
      }
    } else if (st.active) {
      if (st.clearedSince === null) st.clearedSince = now;
      if (now - st.clearedSince >= this.config.rearmMinutes * MINUTE) {
        st.active = false;
        st.clearedSince = null;
      }
    }
  }
}
