import {
  PERIOD_LABELS,
  SIGNAL_KINDS,
  SIGNAL_META,
  type PeriodKind,
  type PeriodMode,
  type ProviderId,
  type Schedule,
  type SignalKind,
  type UsageStats,
} from '@limit-budget/core';
import type { StoredAnomaly, StoredNote } from '../shared/db.js';
import type { ProxyInfo } from '../shared/ipc.js';
import { formToProxy, proxyToForm, type ProxyFormMode, type ProxyScheme } from '../shared/proxy.js';
import type { ViewState } from '../shared/service.js';
import type { AppSettings, SoundId } from '../shared/settings.js';
import { barChart, heatColor } from './charts.js';
import { clear, h } from './dom.js';
import { WEEKDAYS, dateTime, hours, pct, signed } from './format.js';

const api = window.api;
const root = document.getElementById('root')!;

type Tab = 'overview' | 'models' | 'heatmap' | 'journal' | 'settings';
const TABS: Array<[Tab, string]> = [
  ['overview', 'Обзор'],
  ['models', 'Модели и режимы'],
  ['heatmap', 'Карта «час × день»'],
  ['journal', 'Журнал'],
  ['settings', 'Настройки'],
];

const hashParts = location.hash.slice(1).split(':');
const ui = {
  /** Куда прокрутить после открытия вкладки (например, к панели прокси). */
  focus: hashParts[1] ?? '',
  tab: (hashParts[0] as Tab) || ('overview' as Tab),
  provider: 'claude' as ProviderId,
  kind: 'week' as PeriodKind,
  mode: 'rolling' as PeriodMode,
  heat: 'pct7dPerHour' as 'pct7dPerHour' | 'pct5hPerHour' | 'minutes',
};
if (!TABS.some(([t]) => t === ui.tab)) ui.tab = 'overview';

let view: ViewState | null = null;
let settings: AppSettings;
let schedule: Schedule;
let stats: UsageStats | null = null;
let notes: StoredNote[] = [];
let anomalies: StoredAnomaly[] = [];
let proxyInfo: ProxyInfo | null = null;

const main = h('main');
const header = h('header');
root.append(h('div', { class: 'dash' }, header, main));

function seg<T extends string>(items: Array<[T, string]>, value: T, onPick: (v: T) => void, testid?: string): HTMLElement {
  return h(
    'div',
    { class: 'seg', dataset: testid ? { testid } : {} },
    ...items.map(([v, label]) => h('button', { class: v === value ? 'active' : '', onclick: () => onPick(v) }, label)),
  );
}

function renderHeader(): void {
  clear(header);
  header.append(
    h('h1', {}, 'Лимиты Claude / Codex'),
    h('div', { class: 'tabs' }, ...TABS.map(([t, label]) => h('button', { class: t === ui.tab ? 'active' : '', dataset: { tab: t }, onclick: () => go(t) }, label))),
    h('span', { class: 'spacer' }),
    seg(
      view?.providers.filter((p) => p.enabled).map((p) => [p.id, p.label] as [ProviderId, string]) ?? [['claude', 'Claude']],
      ui.provider,
      (p) => {
        ui.provider = p;
        void refresh();
      },
    ),
    seg(
      [
        ['work', 'Работа'],
        ['vacation', 'Отпуск'],
      ],
      view?.mode ?? 'work',
      (m) => void api.setMode(m),
    ),
  );
}

function go(t: Tab): void {
  ui.tab = t;
  location.hash = t;
  void render();
}

async function refresh(): Promise<void> {
  [view, settings, schedule] = await Promise.all([api.getState(), api.getSettings(), api.getSchedule()]);
  stats = await api.getStats(ui.provider, ui.kind, ui.mode);
  [notes, anomalies, proxyInfo] = await Promise.all([api.listNotes(), api.listAnomalies(), api.getProxy()]);
  await render();
}

async function render(): Promise<void> {
  renderHeader();
  clear(main);
  if (ui.tab === 'overview') main.append(...overview());
  if (ui.tab === 'models') main.append(...models());
  if (ui.tab === 'heatmap') main.append(...heatmap());
  if (ui.tab === 'journal') main.append(...journal());
  if (ui.tab === 'settings') {
    main.append(...settingsTab());
    if (ui.focus === 'proxy') {
      main.querySelector('[data-testid=proxy-panel]')?.scrollIntoView({ block: 'start' });
      ui.focus = '';
    }
  }
}

// --- Обзор ---------------------------------------------------------------------------------

function kpi(label: string, value: string, cls = ''): HTMLElement {
  return h('div', { class: 'kpi' }, h('div', { class: 'l' }, label), h('div', { class: `n ${cls}` }, value));
}

function overview(): Node[] {
  if (!stats || !view || !settings) return [h('div', { class: 'empty' }, 'Загрузка…')];
  const s = stats;
  // Допустимый расход за рабочий час: недельная цель, делённая на все взвешенные часы недели по расписанию.
  const weekHours = schedule.blocks.reduce((a, b) => {
    const [sh, sm] = b.start.split(':').map(Number);
    const [eh, em] = b.end.split(':').map(Number);
    return a + ((eh * 60 + em - (sh * 60 + sm)) / 60) * b.weight;
  }, 0);
  const pace = weekHours > 0 ? (100 * (1 - settings.reserve)) / weekHours : 0;
  const days = s.days.filter((d) => d.workHours > 0 || d.gain7d > 0 || d.gain5h > 0);
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    seg(
      (Object.keys(PERIOD_LABELS) as PeriodKind[]).map((k) => [k, PERIOD_LABELS[k]] as [PeriodKind, string]),
      ui.kind,
      (k) => {
        ui.kind = k;
        void refresh();
      },
      'period',
    ),
    seg(
      [
        ['rolling', 'Скользящее окно'],
        ['calendar', 'Календарный период'],
      ],
      ui.mode,
      (m) => {
        ui.mode = m;
        void refresh();
      },
    ),
    h('span', { class: 'spacer' }),
    h('button', { onclick: () => void api.exportData(ui.provider, 'snapshots', 'csv', ui.kind, ui.mode) }, 'Снимки CSV'),
    h('button', { onclick: () => void api.exportData(ui.provider, 'days', 'csv', ui.kind, ui.mode) }, 'Дни CSV'),
    h('button', { onclick: () => void api.exportData(ui.provider, 'models', 'json', ui.kind, ui.mode) }, 'Модели JSON'),
  );
  const t = s.timeLeft;
  const kpis = h(
    'div',
    { class: 'kpis' },
    kpi('Прирост недели', `${s.totals.gain7d.toFixed(1)} п.п.`),
    kpi('Прирост 5ч', `${s.totals.gain5h.toFixed(1)} п.п.`),
    kpi('Пик 5ч-окна', pct(s.totals.peak5h)),
    kpi('Окон открыто', String(s.totals.windows)),
    kpi('Время работы', hours(s.totals.workMinutes / 60)),
    kpi('Остаток времени', t.hoursLeft === null ? '—' : t.notEnough ? `${hours(t.hoursLeft)} · не хватит` : hours(t.hoursLeft), t.notEnough ? 'bad' : ''),
  );
  const note = view.mode === 'vacation' ? h('div', { class: 'notice' }, 'Сейчас режим «Отпуск»: статистика копится с пометкой, цели и сигналы выключены.') : null;

  const chart7 = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Недельный процент по дням'),
    h('p', { class: 'hint' }, 'Оранжевая черта — допустимый расход за день: рабочие часы × недельная цель ÷ часы недели.'),
    barChart(days.map((d) => ({ label: d.date.slice(5), value: d.gain7d, marker: pace * d.workHours, muted: d.vacation })), { unit: ' п.п.' }),
  );
  const chart5 = h('div', { class: 'panel' }, h('h2', {}, '5-часовой процент по дням'), barChart(days.map((d) => ({ label: d.date.slice(5), value: d.gain5h, muted: d.vacation })), { color: '#b78cf0', unit: ' п.п.' }));
  const dev = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Отклонение от цели T(t) на конец дня'),
    h('p', { class: 'hint' }, 'Выше нуля — расход выше траектории, ниже — есть запас.'),
    barChart(days.filter((d) => d.deviationEnd !== null).map((d) => ({ label: d.date.slice(5), value: d.deviationEnd!, muted: d.vacation })), { color: '#4ec882', negativeColor: '#4ec882', unit: ' п.п.' }),
  );

  const blocks = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Блоки: «доступно сейчас» и отклонение'),
    s.blocks.length
      ? h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...['Дата', 'Блок', 'Доступно: начало → конец', 'Отклонение: начало → конец', 'Прирост 5ч', 'Прирост нед.'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
          h(
            'tbody',
            {},
            ...s.blocks.slice(-40).reverse().map((b) =>
              h(
                'tr',
                {},
                h('td', {}, b.date),
                h('td', {}, b.index === 0 ? 'утро' : 'вечер'),
                h('td', { class: 'num' }, `${pct(b.availableStart)} → ${pct(b.availableEnd)}`),
                h('td', { class: 'num' }, `${signed(b.deviationStart)} → ${signed(b.deviationEnd)}`),
                h('td', { class: 'num' }, b.gain5h.toFixed(1)),
                h('td', { class: 'num' }, b.gain7d.toFixed(2)),
              ),
            ),
          ),
        )
      : h('div', { class: 'empty' }, 'За период ещё не было блоков с данными.'),
  );

  const split = s.peakSplit;
  const regimeRow = (name: string, r: typeof split.peak) =>
    h('tr', {}, h('td', {}, name), h('td', { class: 'num' }, hours(r.hours)), h('td', { class: 'num' }, r.d5h.toFixed(1)), h('td', { class: 'num' }, r.d7d.toFixed(2)), h('td', { class: 'num' }, r.pct5hPerHour === null ? '—' : r.pct5hPerHour.toFixed(1)), h('td', { class: 'num' }, r.pct7dPerHour === null ? '—' : r.pct7dPerHour.toFixed(2)), h('td', { class: 'num' }, r.k === null ? '—' : `${r.k.toFixed(3)} (${r.samples})`));
  const peak = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Пиковые и непиковые часы'),
    h('p', { class: 'hint' }, `Профиль пика: ${settings.peak.start}–${settings.peak.end} ${settings.peak.tz}${settings.peak.enabled ? '' : ' (выключен)'}. k — медиана отношения недельного прироста к 5-часовому, в скобках число пар.`),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...['Часы', 'Работа', 'Δ 5ч', 'Δ нед.', '5ч на час', 'нед. на час', 'k'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', {}, regimeRow('Пик', split.peak), regimeRow('Вне пика', split.offpeak)),
    ),
  );
  return [...(note ? [note] : []), toolbar, kpis, chart7, chart5, dev, blocks, peak];
}

// --- Модели и режимы -----------------------------------------------------------------------

function models(): Node[] {
  if (!stats) return [h('div', { class: 'empty' }, 'Загрузка…')];
  const rows = stats.models;
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    seg(
      (Object.keys(PERIOD_LABELS) as PeriodKind[]).map((k) => [k, PERIOD_LABELS[k]] as [PeriodKind, string]),
      ui.kind,
      (k) => {
        ui.kind = k;
        void refresh();
      },
    ),
    seg(
      [
        ['rolling', 'Скользящее окно'],
        ['calendar', 'Календарный период'],
      ],
      ui.mode,
      (m) => {
        ui.mode = m;
        void refresh();
      },
    ),
  );
  const table = rows.length
    ? h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ...['Модель', 'Режим', 'Работа по росту %', 'Время задач', 'Δ 5ч', 'Δ нед.', '5ч на час', 'нед. на час'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
        h(
          'tbody',
          {},
          ...rows.map((r) =>
            h(
              'tr',
              {},
              h('td', {}, r.model === 'unknown' ? 'не определена' : r.model, r.estimated ? h('span', { class: 'est' }, ' оценка') : null),
              h('td', {}, r.effort ?? '—'),
              h('td', { class: 'num' }, hours(r.growthMinutes / 60)),
              h('td', { class: 'num' }, r.taskMinutes > 0 ? `${hours(r.taskMinutes / 60)} (${r.taskCount})` : '—'),
              h('td', { class: 'num' }, r.d5h.toFixed(1)),
              h('td', { class: 'num' }, r.d7d.toFixed(2)),
              h('td', { class: 'num' }, r.pct5hPerHour === null ? '—' : r.pct5hPerHour.toFixed(1)),
              h('td', { class: 'num' }, r.pct7dPerHour === null ? '—' : r.pct7dPerHour.toFixed(2)),
            ),
          ),
        ),
      )
    : h('div', { class: 'empty' }, 'Данных за период нет.');
  return [
    toolbar,
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Время работы и съеденные проценты'),
      h('p', { class: 'hint' }, 'Время работы считается двумя способами рядом: по росту процента и по времени выполнения завершённых задач. Проценты на час берут время задач, если оно известно, иначе интервалы роста. Строки «не определена» помечены как оценка: модель не была отмечена.'),
      table,
    ),
  ];
}

// --- Карта ---------------------------------------------------------------------------------

function heatmap(): Node[] {
  if (!stats) return [h('div', { class: 'empty' }, 'Загрузка…')];
  const st = stats;
  const cells = new Map(st.heatmap.map((c) => [`${c.weekday}-${c.hour}`, c]));
  const val = (c?: (typeof st.heatmap)[number]) => (c ? (ui.heat === 'minutes' ? c.minutes : (c[ui.heat] ?? null)) : null);
  const all = st.heatmap.map((c) => val(c)).filter((v): v is number => v !== null && v > 0);
  const max = Math.max(1e-9, ...all);
  const grid = h('div', { class: 'heat' }, h('span'), ...Array.from({ length: 24 }, (_, i) => h('span', { class: 'h' }, String(i))));
  for (let wd = 1; wd <= 7; wd++) {
    grid.append(h('span', { class: 'd' }, WEEKDAYS[wd - 1]));
    for (let hr = 0; hr < 24; hr++) {
      const c = cells.get(`${wd}-${hr}`);
      const v = val(c);
      const cell = h('span', { class: 'c', style: v ? `background:${heatColor(v / max)}` : '' }, v ? (v >= 10 ? v.toFixed(0) : v.toFixed(1)) : '');
      cell.title = c ? `${WEEKDAYS[wd - 1]} ${hr}:00 — работа ${c.minutes.toFixed(0)} мин, Δ5ч ${c.d5h.toFixed(1)}, Δнед ${c.d7d.toFixed(2)}` : `${WEEKDAYS[wd - 1]} ${hr}:00 — данных нет`;
      grid.append(cell);
    }
  }
  return [
    h(
      'div',
      { class: 'toolbar' },
      seg(
        [
          ['pct7dPerHour', 'Недельный % на час'],
          ['pct5hPerHour', '5-часовой % на час'],
          ['minutes', 'Минуты работы'],
        ],
        ui.heat,
        (v) => {
          ui.heat = v;
          void render();
        },
      ),
      seg(
        (Object.keys(PERIOD_LABELS) as PeriodKind[]).map((k) => [k, PERIOD_LABELS[k]] as [PeriodKind, string]),
        ui.kind,
        (k) => {
          ui.kind = k;
          void refresh();
        },
      ),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Эффективность по часам'),
      h('p', { class: 'hint' }, 'Процент на час работы в корзине «день недели × час» (часы в поясе расписания). Ячейки с работой меньше 10 минут не показываются. Тёплые цвета — тяжёлые часы.'),
      grid,
      h('div', { class: 'legend' }, h('span', {}, h('i', { style: `background:${heatColor(0)}` }), 'мало'), h('span', {}, h('i', { style: `background:${heatColor(0.5)}` }), 'средне'), h('span', {}, h('i', { style: `background:${heatColor(1)}` }), 'много')),
    ),
  ];
}

// --- Журнал --------------------------------------------------------------------------------

function journal(): Node[] {
  const input = h('input', { placeholder: 'Например: лимиты подняли, новая модель, поездка', style: 'flex:1;min-width:260px' });
  const add = async () => {
    if (!input.value.trim()) return;
    await api.addNote(input.value.trim(), ui.provider);
    input.value = '';
    notes = await api.listNotes();
    await render();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && void add());
  return [
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Возможные изменения лимитов'),
      h('p', { class: 'hint' }, 'Без токенов нельзя отличить тяжёлые запросы от изменения лимита, поэтому это «возможное изменение», а не подтверждённое. Ручные пометки ниже объясняют скачки, не связанные с вашим поведением.'),
      anomalies.length
        ? h(
            'div',
            {},
            ...anomalies.map((a) => h('div', { class: 'note-item' }, h('span', { class: 'when' }, dateTime(a.ts)), h('span', {}, `${a.provider} · ${a.window} · ${a.kind} · ×${a.ratio.toFixed(2)} — ${a.note ?? ''}`))),
          )
        : h('div', { class: 'empty' }, 'Пока не обнаружено.'),
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Пометки'),
      h('div', { class: 'row-inline', style: 'margin-bottom:8px' }, input, h('button', { class: 'primary', onclick: () => void add() }, 'Добавить')),
      notes.length
        ? h(
            'div',
            {},
            ...notes.map((n) =>
              h(
                'div',
                { class: 'note-item' },
                h('span', { class: 'when' }, dateTime(n.ts)),
                h('span', { style: 'flex:1' }, n.text),
                h('button', { title: 'Удалить', onclick: async () => (await api.deleteNote(n.id), (notes = await api.listNotes()), render()) }, '✕'),
              ),
            ),
          )
        : h('div', { class: 'empty' }, 'Пометок нет.'),
    ),
  ];
}

// --- Настройки -----------------------------------------------------------------------------

const SOUND_LABELS: Record<SoundId, string> = {
  warning: 'Предупреждение (два тона вниз)',
  exceeded: 'Превышение (резкие чередующиеся)',
  soft: 'Тихий звонок',
  tick: 'Короткий щелчок',
  change: 'Арпеджио вверх',
  none: 'Без звука',
};

function settingsTab(): Node[] {
  if (!settings) return [h('div', { class: 'empty' }, 'Загрузка…')];
  const s = structuredClone(settings);
  const sched = structuredClone(schedule);

  const num = (value: number | null, step = '1', min?: string, max?: string) => h('input', { type: 'number', value: value === null ? '' : String(value), step, min, max, style: 'width:90px' });
  const reserve = num(Math.round(s.reserve * 100), '1', '0', '50');
  const dev = num(s.deviationPct, '0.5', '0', '50');
  const low = num(s.lowAvailablePct, '0.5', '0', '50');
  const manualK = num(s.manualK, '0.01', '0');
  const poll = num(s.pollIntervalSec, '5', '15');
  const pause = num(s.pauseThresholdMin, '1', '1');
  const retention = num(s.rawRetentionDays, '10', '7');
  // Прокси: режим, тип, адрес и порт. Порт подсказывается списком распространённых (v2rayN, Clash и т. п.).
  const pf = proxyToForm(s.proxy);
  const SCHEME_LABELS: Record<ProxyScheme, string> = { socks5: 'SOCKS5', http: 'HTTP', socks4: 'SOCKS4', https: 'HTTPS' };
  const proxyMode = h(
    'select',
    { dataset: { testid: 'proxy-mode' } },
    h('option', { value: 'custom', selected: pf.mode === 'custom' }, 'Свой прокси (указать порт)'),
    h('option', { value: 'system', selected: pf.mode === 'system' }, 'Системный (как в Windows)'),
    h('option', { value: 'direct', selected: pf.mode === 'direct' }, 'Без прокси'),
  );
  const proxyScheme = h('select', { dataset: { testid: 'proxy-scheme' } }, ...(Object.keys(SCHEME_LABELS) as ProxyScheme[]).map((x) => h('option', { value: x, selected: pf.scheme === x }, SCHEME_LABELS[x])));
  const proxyHost = h('input', { value: pf.host, style: 'width:140px', placeholder: '127.0.0.1', dataset: { testid: 'proxy-host' } });
  const proxyPort = h('input', { value: pf.port, list: 'proxy-ports', style: 'width:90px', placeholder: '10808', inputMode: 'numeric', dataset: { testid: 'proxy-port' } });
  const proxyPorts = h('datalist', { id: 'proxy-ports' }, ...['10808', '10809', '7890', '7891', '1080', '8080'].map((v) => h('option', { value: v })));
  const syncProxyForm = () => {
    for (const el of [proxyScheme, proxyHost, proxyPort]) el.disabled = proxyMode.value !== 'custom';
  };
  proxyMode.addEventListener('change', syncProxyForm);
  syncProxyForm();
  const readProxyForm = (): string | null =>
    formToProxy({ mode: proxyMode.value as ProxyFormMode, scheme: proxyScheme.value as ProxyScheme, host: proxyHost.value, port: proxyPort.value });
  const check = (v: boolean) => h('input', { type: 'checkbox', checked: v });
  const peakOn = check(s.peak.enabled);
  const peakStart = h('input', { type: 'time', value: s.peak.start });
  const peakEnd = h('input', { type: 'time', value: s.peak.end });
  const tz = h('input', { value: sched.tz, style: 'width:120px' });
  const notif = check(s.notifications);
  const autostart = check(s.startWithWindows);
  const fallback = check(s.desktopSessionFallback);
  const desktopResult = h('div', { class: 'small', style: 'margin-top:4px;white-space:pre-wrap' });
  const tryDesktopNow = h('button', {
    onclick: async (e: Event) => {
      const b = e.target as HTMLButtonElement;
      b.disabled = true;
      desktopResult.textContent = 'Проверяю…';
      try {
        const r = await api.login.tryDesktop();
        desktopResult.className = r.ok ? 'notice small' : 'notice bad small';
        desktopResult.textContent = r.message;
      } finally {
        b.disabled = false;
      }
    },
  }, 'Попробовать сейчас');
  const claudeOn = check(s.providers.claude.enabled);
  const gptOn = check(s.providers.chatgpt.enabled);
  const volume = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.sounds.volume) });
  const muted = check(s.sounds.muted);
  const remind = num(s.signals.reminderMinutes, '5', '0');
  const rearm = num(s.signals.rearmMinutes, '1', '0');
  const opacity = h('input', { type: 'range', min: '0.4', max: '1', step: '0.02', value: String(s.widget.opacity) });
  const clickThrough = check(s.widget.clickThrough);

  // расписание: два блока в день
  const days = Array.from({ length: 7 }, (_, i) => {
    const wd = i + 1;
    const blocks = sched.blocks.filter((b) => b.weekday === wd).sort((a, b) => (a.start < b.start ? -1 : 1));
    return {
      wd,
      on: check(blocks.length > 0),
      b: [0, 1].map((k) => ({
        start: h('input', { type: 'time', value: blocks[k]?.start ?? (k === 0 ? '10:00' : '15:00') }),
        end: h('input', { type: 'time', value: blocks[k]?.end ?? (k === 0 ? '14:00' : '19:00') }),
        weight: h('input', { type: 'number', step: '0.1', min: '0', value: String(blocks[k]?.weight ?? 1), style: 'width:60px' }),
      })),
    };
  });
  const scheduleTable = h(
    'table',
    {},
    h('thead', {}, h('tr', {}, h('th', {}, 'День'), h('th', {}, 'Утро (с — по, вес)'), h('th', {}, 'Вечер (с — по, вес)'))),
    h('tbody', {}, ...days.map((d) => h('tr', {}, h('td', {}, h('label', { class: 'row-inline' }, d.on, WEEKDAYS[d.wd - 1])), ...d.b.map((b) => h('td', {}, h('div', { class: 'row-inline' }, b.start, '—', b.end, b.weight)))))),
  );
  // исключения
  const exList = h('div');
  const drawEx = () => {
    clear(exList);
    sched.exceptions.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!sched.exceptions.length) exList.append(h('div', { class: 'empty' }, 'Исключений нет.'));
    sched.exceptions.forEach((e, i) =>
      exList.append(h('div', { class: 'row-inline' }, `${e.date} — ${e.type === 'off' ? 'выходной' : 'рабочий день'}`, h('button', { onclick: () => (sched.exceptions.splice(i, 1), drawEx()) }, '✕'))),
    );
  };
  drawEx();
  const exDate = h('input', { type: 'date' });
  const exType = h('select', {}, h('option', { value: 'off' }, 'выходной'), h('option', { value: 'work' }, 'рабочий день'));

  // сигналы и звуки
  const sigRows = SIGNAL_KINDS.map((k: SignalKind) => {
    const on = check(s.signals.enabled[k]);
    const sel = h('select', {}, ...(Object.keys(SOUND_LABELS) as SoundId[]).map((id) => h('option', { value: id, selected: s.sounds.perKind[k].sound === id }, SOUND_LABELS[id])));
    const file = h('span', { class: 'small' }, s.sounds.perKind[k].file ?? '');
    const state = { file: s.sounds.perKind[k].file as string | undefined };
    const pick = h('button', { onclick: async () => {
      const f = await api.pickSoundFile();
      if (f) {
        state.file = f;
        file.textContent = f;
      }
    } }, 'Свой файл…');
    const reset = h('button', { onclick: () => ((state.file = undefined), (file.textContent = '')) }, 'Сбросить');
    const test = h('button', { onclick: async () => {
      // Проверка звука использует сохранённые настройки, поэтому сначала сохраняем выбор этой строки.
      await api.updateSettings({ sounds: { perKind: { [k]: { sound: sel.value, file: state.file } } } });
      await api.testSound(k);
    } }, '▶');
    return { k, on, sel, state, row: h('tr', {}, h('td', {}, on), h('td', {}, `${SIGNAL_META[k].label}`, h('div', { class: 'small' }, { exceeded: 'превышение', warning: 'предупреждение', quiet: 'тихий', info: 'информация' }[SIGNAL_META[k].severity])), h('td', {}, sel), h('td', {}, h('div', { class: 'row-inline' }, pick, reset, test), file)) };
  });

  // Прокси: что используется сейчас, перекрытие ключом запуска и проверка связи.
  const proxyState = h('div', { class: 'small', style: 'margin-top:8px;white-space:pre-wrap', dataset: { testid: 'proxy-state' } });
  const showProxy = (info: ProxyInfo | null, extra = '') => {
    const src = info && { launch: 'ключ запуска --proxy', env: 'переменная LIMIT_BUDGET_PROXY', settings: 'настройки' }[info.source];
    proxyState.textContent =
      (info ? `Сейчас используется: ${info.display} (${src}); Chromium выбирает для claude.ai: ${info.resolved}` : '') +
      (info?.overridesSettings ? '\nЗначение из поля сохранится, но пока работает ' + (info.source === 'launch' ? 'ключ запуска' : 'переменная окружения') + '.' : '') +
      (extra ? `\n${extra}` : '');
  };
  showProxy(proxyInfo);
  // После удачной проверки связи сразу предлагаем войти: обычно прокси задают именно ради входа.
  const loginAfter = h('button', { style: 'display:none;margin-top:8px', dataset: { testid: 'proxy-login' }, onclick: () => void api.openLogin() }, 'Войти в Claude…');
  const applyProxyAndTest = async (e: Event) => {
    const b = e.target as HTMLButtonElement;
    b.disabled = true;
    try {
      settings = await api.updateSettings({ proxy: readProxyForm() });
      proxyInfo = await api.getProxy();
      showProxy(proxyInfo, 'Проверяю связь с claude.ai…');
      const r = await api.testProxy();
      const google = r.google ? (r.google.reachable ? `Google (вход): отвечает, HTTP ${r.google.status}, ${r.google.ms} мс` : `Google (вход): недоступен — ${r.google.error}`) : '';
      const windows = r.windows?.length ? `\nОткрытые окна: ${r.windows.map((w) => `${w.kind} ${w.host} → ${w.proxy}`).join('; ')}` : '';
      showProxy(proxyInfo, (r.reachable ? `Связь есть: HTTP ${r.status}, ${r.ms} мс${r.country ? `, страна выхода ${r.country}` : ''}` : `Связи нет: ${r.error}`) + (google ? `\n${google}` : '') + windows);
      loginAfter.style.display = r.reachable ? '' : 'none';
    } catch (err) {
      // Ошибка проверки адреса приходит из главного процесса; прежняя рабочая настройка не тронута.
      showProxy(proxyInfo, `Не применено: ${(err as Error).message.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/, '')}`);
    } finally {
      b.disabled = false;
    }
  };

  const save = h('button', { class: 'primary', dataset: { testid: 'save' } }, 'Сохранить настройки');
  const status = h('span', { class: 'small' });
  const doSave = async () => {
    const perKind: Record<string, { sound: SoundId; file?: string }> = {};
    const enabled: Record<string, boolean> = {};
    for (const r of sigRows) {
      perKind[r.k] = { sound: r.sel.value as SoundId, file: r.state.file };
      enabled[r.k] = r.on.checked;
    }
    const kVal = manualK.value.trim();
    settings = await api.updateSettings({
      reserve: Number(reserve.value) / 100,
      deviationPct: Number(dev.value),
      lowAvailablePct: Number(low.value),
      manualK: kVal === '' ? null : Number(kVal),
      pollIntervalSec: Number(poll.value),
      pauseThresholdMin: Number(pause.value),
      rawRetentionDays: Number(retention.value),
      peak: { enabled: peakOn.checked, start: peakStart.value, end: peakEnd.value },
      notifications: notif.checked,
      startWithWindows: autostart.checked,
      desktopSessionFallback: fallback.checked,
      proxy: readProxyForm(),
      providers: { claude: { enabled: claudeOn.checked }, chatgpt: { enabled: gptOn.checked } },
      sounds: { volume: Number(volume.value), muted: muted.checked, perKind },
      signals: { enabled, reminderMinutes: Number(remind.value), rearmMinutes: Number(rearm.value) },
      widget: { opacity: Number(opacity.value), clickThrough: clickThrough.checked },
    });
    const blocks = days.flatMap((d) =>
      d.on.checked ? d.b.map((b) => ({ weekday: d.wd, start: b.start.value, end: b.end.value, weight: Number(b.weight.value) })) : [],
    );
    await api.setSchedule({ tz: tz.value.trim() || 'UTC+3', blocks, exceptions: sched.exceptions });
    status.textContent = 'Сохранено';
    await refresh();
  };
  save.addEventListener('click', () => {
    status.textContent = '';
    doSave().catch((err) => {
      // Например, неверный адрес прокси: настройки не сохранены, причина показана рядом с кнопкой.
      status.textContent = `Не сохранено: ${(err as Error).message.replace(/^Error invoking remote method '[^']+': (\w+Error: )?/, '')}`;
    });
  });

  const f = (label: string, ...ctl: Array<Node | string>) => [h('label', {}, label), h('div', { class: 'row-inline' }, ...ctl)];
  return [
    h('div', { class: 'panel' }, h('h2', {}, 'Бюджет'), h('div', { class: 'form-grid' },
      ...f('Резерв недельного лимита, %', reserve, h('span', { class: 'small' }, 'всегда включён')),
      ...f('Порог отклонения δ, п.п.', dev),
      ...f('«Доступно сейчас» ниже, п.п.', low, h('span', { class: 'small' }, 'предупреждение')),
      ...f('k вручную (нед. на 1% окна)', manualK, h('span', { class: 'small' }, 'используется, пока не накоплены данные; пусто — только по окну')),
      ...f('Часовой пояс расписания', tz, h('span', { class: 'small' }, 'например UTC+3')),
    )),
    h('div', { class: 'panel' }, h('h2', {}, 'Расписание'), h('p', { class: 'hint' }, 'Рабочие окна, по которым строится недельная траектория; выходные не входят в бюджет. Утро и вечер по умолчанию равны по весу.'), scheduleTable,
      h('h2', { style: 'margin-top:12px' }, 'Исключения'), exList,
      h('div', { class: 'row-inline', style: 'margin-top:6px' }, exDate, exType, h('button', { onclick: () => { if (exDate.value) { sched.exceptions = sched.exceptions.filter((e) => e.date !== exDate.value); sched.exceptions.push({ date: exDate.value, type: exType.value as 'off' | 'work' }); drawEx(); } } }, 'Добавить'))),
    h('div', { class: 'panel' }, h('h2', {}, 'Пиковые часы'), h('div', { class: 'form-grid' },
      ...f('Учитывать пик', peakOn),
      ...f(`Пик в поясе ${s.peak.tz}`, peakStart, '—', peakEnd, h('span', { class: 'small' }, 'пересчёт в ваш пояс и переход на зимнее время — автоматически')),
    )),
    h('div', { class: 'panel' }, h('h2', {}, 'Сигналы и звуки'), h('p', { class: 'hint' }, 'Звуки звучат в любое время, включая обед и часы вне рабочих окон. Каждый сигнал срабатывает один раз за пересечение порога; в режиме «Отпуск» и при устаревших данных сигналов нет.'),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Событие'), h('th', {}, 'Звук'), h('th', {}, 'Файл'))), h('tbody', {}, ...sigRows.map((r) => r.row))),
      h('div', { class: 'form-grid', style: 'margin-top:10px' },
        ...f('Громкость', volume), ...f('Без звука', muted), ...f('Напоминание, мин (0 — нет)', remind), ...f('Повторное взведение, мин', rearm), ...f('Системные уведомления Windows', notif))),
    h('div', { class: 'panel' }, h('h2', {}, 'Провайдеры и вход'), h('div', { class: 'form-grid' },
      ...f(
        'Claude',
        claudeOn,
        h('button', { onclick: () => void api.openLogin() }, 'Войти в Claude…'),
        h('span', { class: 'link small', onclick: () => void api.login.openHelp() }, 'не получилось?'),
      ),
      ...f('ChatGPT Desktop (Codex)', gptOn, h('span', { class: 'small' }, api.isDemo ? 'в демо — обезличенные фикстуры' : 'читает локальные логи Codex (~/.codex/sessions), входа не нужно; облачные задачи могут не отражаться')),
      ...f('Сессия Claude Desktop', fallback, h('span', { class: 'small' }, 'автоматически, раз в 6 часов, пока «нужен вход»'), tryDesktopNow),
      ...f('', desktopResult),
      ...f('Опрос, сек', poll, h('span', { class: 'small' }, 'пока процент растёт, вдвое чаще')),
      ...f('Склейка пауз, мин', pause, h('span', { class: 'small' }, 'интервалы роста процента')),
      ...f('Хранить сырую активность, дн.', retention, h('span', { class: 'small' }, 'снимки и дневные агрегаты — бессрочно')),
    )),
    h('div', { class: 'panel', dataset: { testid: 'proxy-panel' } }, h('h2', {}, 'Сеть и прокси'),
      h('p', { class: 'hint' }, 'Все запросы к claude.ai и вход идут через этот прокси. Для v2rayN / xray обычно SOCKS5, адрес 127.0.0.1, порт 10808 (HTTP — 10809). Логин и пароль не поддерживаются. Ключ запуска --proxy и переменная LIMIT_BUDGET_PROXY важнее этих полей.'),
      h('div', { class: 'form-grid' },
        ...f('Режим', proxyMode),
        ...f('Тип, адрес и порт', proxyScheme, proxyHost, ':', proxyPort, proxyPorts),
        ...f('', h('button', { class: 'primary', dataset: { testid: 'proxy-apply' }, onclick: applyProxyAndTest }, 'Применить и проверить'))),
      proxyState,
      loginAfter),
    h('div', { class: 'panel' }, h('h2', {}, 'Виджет'), h('div', { class: 'form-grid' },
      ...f('Прозрачность', opacity), ...f('Пропускать клики', clickThrough), ...f('Запускать вместе с Windows', autostart),
      ...f('Данные программы', h('button', { dataset: { testid: 'open-data' }, onclick: () => void api.openDataFolder() }, 'Открыть папку данных'), h('span', { class: 'small' }, 'настройки, база, отчёты шага 0')))),
    h('div', { class: 'panel' }, h('h2', {}, 'Шаг 0: спайк по источникам данных'), h('p', { class: 'hint' }, 'Проверяет эндпоинт использования claude.ai, долговечность входа и rollout-логи Codex, пишет обезличенный отчёт data-sources.generated.md.'),
      h('div', { class: 'row-inline' }, h('button', { onclick: async (e: Event) => { const b = e.target as HTMLButtonElement; b.disabled = true; const r = await api.runSpike().finally(() => (b.disabled = false)); spikeOut.textContent = `${r.summary.join('\n')}\n\nОтчёт: ${r.file}`; } }, 'Запустить спайк')),
      (spikeOut = h('pre', { class: 'small', style: 'white-space:pre-wrap' }))),
    h('div', { class: 'row-inline' }, save, status),
  ];
}
let spikeOut: HTMLElement = h('pre');

// --- запуск --------------------------------------------------------------------------------

api.onState((s) => {
  view = s;
  // Данные обновляются раз в минуту; страницу настроек не трогаем, чтобы не сбросить правку.
  if (ui.tab !== 'settings') void refresh();
  else renderHeader();
});
function navigate(target: string): void {
  const [t, focus] = target.split(':') as [Tab, string | undefined];
  if (!TABS.some(([x]) => x === t)) return;
  ui.focus = focus ?? '';
  if (t === ui.tab) {
    // Смена хеша после щелчка по вкладке уже отрисована; перерисовываем только ради прокрутки к нужному месту.
    if (ui.focus) void render();
  } else go(t);
}
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
// Окно уже открыто, а из трея или виджета просят показать, например, настройки прокси.
api.onTab((target) => navigate(target));
void refresh();
