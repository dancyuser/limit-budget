import type { ProviderView, ViewState } from '../shared/service.js';
import type { AppSettings } from '../shared/settings.js';
import { h } from './dom.js';
import { hours, pct, signed, until } from './format.js';
import { playSignal } from './sounds.js';

const api = window.api;
const root = document.getElementById('root')!;

let view: ViewState | null = null;
let settings: AppSettings | null = null;
let expanded = false;
let renderPending = false;
let busy = false; // идёт перетаскивание: перерисовка отложена, иначе потеряется захват указателя

// --- перетаскивание: клик по строке раскрывает карточку, сдвиг мыши двигает окно ------------

function draggable(el: HTMLElement, onClick?: () => void): void {
  let suppressClick = false;
  el.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if ((e.target as HTMLElement).closest('button, input, select, a, .link')) return;
    onClick?.();
  });
  el.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button, input, select, a, .link')) return;
    if (e.button !== 0) return;
    const sx = e.screenX;
    const sy = e.screenY;
    let dragging = false;
    busy = true;
    api.widget.dragStart();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* синтетическое событие без активного указателя */
    }
    const move = (m: PointerEvent) => {
      const dx = m.screenX - sx;
      const dy = m.screenY - sy;
      if (!dragging && Math.hypot(dx, dy) > 4) dragging = true;
      if (dragging) api.widget.dragMove(dx, dy);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      busy = false;
      api.widget.dragEnd();
      // После перетаскивания браузер всё равно пошлёт click: его надо проглотить.
      if (dragging) suppressClick = true;
      if (renderPending) schedule();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// --- статусы ------------------------------------------------------------------------------

type Level = 'ok' | 'warn' | 'bad' | '';

function level(p: ProviderView): Level {
  const b = p.budget;
  if (p.status === 'needs-login' || p.status === 'error') return 'bad';
  if (p.status !== 'ok' || !b) return '';
  if (b.mode === 'vacation') return '';
  if (b.exceeded) return 'bad';
  if (b.status === 'above' || b.lowAvailable || b.windowExhaustsEarly) return 'warn';
  return 'ok';
}

function primary(v: ViewState): ProviderView | undefined {
  return v.providers.find((p) => p.id === 'claude' && p.enabled) ?? v.providers.find((p) => p.enabled);
}

/** Ошибка про связь с claude.ai: подсказываем настройки прокси. */
function isNetworkProblem(error: string | null): boolean {
  return !!error && /прокси|нет связи|не ответил|Cloudflare/i.test(error);
}

function proxyLink(): HTMLElement {
  return h('span', { class: 'link', dataset: { testid: 'proxy-link' }, onclick: (e: Event) => (e.stopPropagation(), void api.openDashboard('settings:proxy')) }, 'Настроить прокси');
}

// --- обновление: кнопка, повтор после сбоя, возвращение сети -----------------------------------

let refreshing = false;

/** Опросить сейчас. Пока идёт опрос, кнопки неактивны, чтобы не запускать второй. */
async function refreshNow(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  schedule();
  try {
    await api.refresh();
  } finally {
    refreshing = false;
    schedule();
  }
}

function refreshButton(label: string): HTMLButtonElement {
  return h(
    'button',
    { class: refreshing ? 'refresh spin' : 'refresh', title: 'Обновить сейчас', disabled: refreshing, dataset: { testid: 'refresh' }, onclick: (e: Event) => (e.stopPropagation(), void refreshNow()) },
    refreshing ? '…' : label,
  ) as HTMLButtonElement;
}

/** «Следующая попытка через N с»: после временного сбоя сервис повторяет опрос сам. */
function retryNote(p: ProviderView, now: number): string {
  if (p.retryAt === null) return '';
  const sec = Math.max(1, Math.round((p.retryAt - now) / 1000));
  return `Следующая попытка через ${sec} с. `;
}

// --- компактная строка ---------------------------------------------------------------------

function compactRow(v: ViewState | null): HTMLElement {
  const p = v && primary(v);
  const row = h('div', { class: 'compact', dataset: { testid: 'compact' } });
  const dot = h('span', { class: 'dot' });
  const line = h('span', { class: 'line' });
  row.append(dot, line);
  if (!v || !p) {
    line.append('Загрузка…');
  } else if (p.status === 'needs-login') {
    dot.classList.add('bad');
    line.append(h('span', { class: 'link', onclick: () => void api.openLogin() }, `Войти в ${p.label}…`));
  } else if (!p.tick || !p.budget) {
    line.append(p.status === 'error' ? `${p.label}: ${p.error ?? 'ошибка'}` : 'Ожидание данных…');
    if (p.status === 'error' && isNetworkProblem(p.error)) line.append(' ', proxyLink());
    if (p.status === 'error') {
      dot.classList.add('bad');
      row.append(refreshButton('↻'));
    }
  } else {
    const l = level(p);
    if (l) dot.classList.add(l);
    const b = p.budget;
    const parts: Array<Node | string> = [];
    if (b.mode === 'vacation') parts.push(h('span', { class: 'muted' }, 'Отпуск'));
    if (p.tick.u5h !== null) parts.push(h('span', {}, '5ч ', h('b', {}, pct(b.u5hEffective ?? p.tick.u5h))));
    if (b.available !== null) parts.push(h('span', {}, 'доступно ', h('b', {}, pct(b.available))));
    parts.push(h('span', {}, 'нед ', h('b', {}, pct(b.usedWeek ?? p.tick.u7d)), b.target !== null ? ` / ${pct(b.target)}` : ''));
    if (p.status === 'stale') parts.push(h('span', { class: 'muted' }, 'устарело'));
    parts.forEach((part, i) => {
      if (i) line.append(' · ');
      line.append(part);
    });
    if (p.status === 'stale') row.classList.add('stale');
    // Данные устарели или опрос не удался: рядом сразу есть кнопка «обновить».
    if (p.status === 'stale' || p.error) row.append(refreshButton('↻'));
  }
  if (v?.peak.now) row.append(h('span', { class: 'badge', title: `Пиковые часы ${v.peak.label ?? ''}` }, '⚡'));
  row.append(h('span', { class: 'chev' }, expanded ? '▴' : '▾'));
  return row;
}

// --- карточка ------------------------------------------------------------------------------

function scale(opts: {
  label: string;
  value: string;
  reset: string;
  fill: number;
  fillClass?: string;
  avail?: { from: number; width: number };
  target?: { at: number; band: number };
}): HTMLElement {
  const bar = h('div', { class: 'bar' }, h('div', { class: `fill ${opts.fillClass ?? ''}`, style: `width:${Math.min(100, Math.max(0, opts.fill))}%` }));
  if (opts.avail && opts.avail.width > 0) {
    bar.append(h('div', { class: 'avail', style: `left:${opts.avail.from}%;width:${Math.min(opts.avail.width, 100 - opts.avail.from)}%` }));
  }
  if (opts.target) {
    const lo = Math.max(0, opts.target.at - opts.target.band);
    const hi = Math.min(100, opts.target.at + opts.target.band);
    bar.append(h('div', { class: 'band', style: `left:${lo}%;width:${hi - lo}%` }), h('div', { class: 'target', style: `left:calc(${opts.target.at}% - 1px)` }));
  }
  return h('div', { class: 'scale' }, h('div', { class: 'row' }, h('span', {}, opts.label, ' ', h('b', {}, opts.value)), h('span', { class: 'muted' }, opts.reset)), bar);
}

function providerBlock(v: ViewState, p: ProviderView): HTMLElement {
  const b = p.budget;
  const t = p.tick;
  const block = h('div', { class: 'prov', dataset: { provider: p.id } });
  const chips: Node[] = [];
  if (p.status === 'stale') chips.push(h('span', { class: 'chip warn' }, 'устарело'));
  if (p.id === 'chatgpt' && api.isDemo) chips.push(h('span', { class: 'chip' }, 'фикстуры'));
  if (v.peak.now) chips.push(h('span', { class: 'chip peak' }, `пик ${v.peak.label ?? ''}`));
  block.append(h('div', { class: 'prov-title' }, h('span', { class: 'name' }, p.label), h('span', {}, ...chips)));

  if (p.status === 'needs-login') {
    block.append(h('div', { class: 'notice bad' }, 'Нужен вход. ', h('span', { class: 'link', onclick: () => void api.openLogin() }, 'Войти в аккаунт')));
    return block;
  }
  if (!t || !b) {
    block.append(
      h(
        'div',
        { class: p.error ? 'notice bad' : 'small' },
        p.error ? `Ошибка: ${p.error}. ${retryNote(p, v.now)}` : 'Ожидание первых данных…',
        p.error ? refreshButton('↻ Обновить') : null,
        ' ',
        p.error && isNetworkProblem(p.error) ? proxyLink() : null,
      ),
    );
    return block;
  }
  if (p.error) {
    block.append(
      h(
        'div',
        { class: 'notice' },
        `Последний опрос не удался: ${p.error}. Показано последнее значение. ${retryNote(p, v.now)}`,
        refreshButton('↻ Обновить'),
        ' ',
        isNetworkProblem(p.error) ? proxyLink() : null,
      ),
    );
  }
  if (b.mode === 'vacation') block.append(h('div', { class: 'small' }, 'Режим «Отпуск»: цели и сигналы выключены. Статистика продолжает копиться с пометкой.'));

  if (t.u5h !== null) {
    const u5 = b.u5hEffective ?? t.u5h;
    block.append(
      scale({
        label: '5-часовое окно',
        value: pct(u5),
        reset: t.r5h ? `сброс через ${until(t.r5h, v.now)}` : 'окно не открыто',
        fill: u5,
        fillClass: u5 >= 90 ? 'bad' : u5 >= 70 ? 'warn' : '',
        avail: b.available !== null ? { from: u5, width: b.available } : undefined,
      }),
    );
  }
  if (t.u7d !== null) {
    const dev = b.deviation;
    // Если сброс недели уже прошёл, а свежих данных нет, показываем начало новой недели, а не расход прошлой.
    const u7 = b.usedWeek ?? t.u7d;
    block.append(
      scale({
        label: 'Неделя',
        value: b.target !== null ? `${pct(u7, 1)} / цель ${pct(b.target, 1)}${dev !== null ? ` (${signed(dev)})` : ''}` : pct(u7, 1),
        reset: `сброс через ${until(t.r7d !== null && t.r7d > v.now ? t.r7d : b.week.end, v.now)}`,
        fill: u7,
        fillClass: b.exceeded ? 'bad' : b.status === 'above' ? 'warn' : '',
        target: b.target !== null ? { at: b.target, band: settings?.deviationPct ?? 5 } : undefined,
      }),
    );
  }

  if (b.windowExhaustsEarly) {
    block.append(h('div', { class: 'notice' }, `5-часовое окно закончится раньше блока: примерно через ${Math.round((b.hoursToExhaust ?? 0) * 60)} мин при текущем темпе.`));
  }
  if (b.exceeded) {
    const windowFull = b.u5hEffective !== null && b.u5hEffective >= 100;
    block.append(h('div', { class: 'notice bad' }, windowFull ? '5-часовое окно израсходовано, дождитесь сброса.' : 'Недельный бюджет израсходован. Дальше расход идёт в резерв недели.'));
  }

  const facts = h('div', { class: 'facts' });
  const row = (k: string, val: Node | string, cls = '') => facts.append(h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, val));
  if (b.mode !== 'vacation') {
    if (b.available !== null) {
      const why = b.limitedBy === 'week' ? 'ограничено неделей' : 'ограничено самим окном';
      const when = b.block && !b.block.inBlock ? ` · для блока с ${new Date(b.block.start + 3 * 3_600_000).toISOString().slice(11, 16)}` : '';
      row('Доступно сейчас', `${pct(b.available)} окна (${why})${when}`, b.available <= 0 ? 'bad' : b.lowAvailable ? 'warn' : 'ok');
    }
    if (b.dayTarget !== null && b.hoursLeftToday > 0) row('К концу дня', `не выше ${pct(b.dayTarget, 1)} недели`);
    row('Осталось', `${hours(b.remainingHours)} рабочих`);
    if (b.hoursLeft !== null) row('Хватит при темпе', b.notEnough ? `${hours(b.hoursLeft)} — не хватит` : hours(b.hoursLeft), b.notEnough ? 'bad' : '');
    if (b.k !== null) {
      const src = { peak: 'в пик', offpeak: 'вне пика', manual: 'введено вручную', other: 'из другого режима' }[b.kSource ?? 'manual'];
      row('k (неделя на 1% окна)', `${b.k.toFixed(3)} · ${src}${b.capacityWindows ? ` · ёмкость ${b.capacityWindows.toFixed(1)} окон` : ''}`);
    }
  }
  block.append(facts);

  // Ручная отметка модели и режима (пока способ из шага 0 не выбран); для провайдеров с логами модель берётся из них.
  if (p.id === 'claude') {
    const set = (m: HTMLInputElement, e: HTMLInputElement) => void api.setModel(p.id, m.value.trim() || null, e.value.trim() || null);
    const m = h('input', { list: 'models', placeholder: 'модель', value: p.currentModel?.model ?? '', title: 'Модель в Claude Desktop' });
    const e = h('input', { list: 'efforts', placeholder: 'режим', value: p.currentModel?.effort ?? '', title: 'Режим рассуждений' });
    m.addEventListener('change', () => set(m, e));
    e.addEventListener('change', () => set(m, e));
    const running = p.openTask;
    block.append(
      h(
        'div',
        { class: 'model-row' },
        m,
        e,
        h('button', { class: running ? 'danger' : '', title: 'Отметить начало и конец задачи для учёта времени выполнения', onclick: () => void (running ? api.stopTask(p.id) : api.startTask(p.id)) }, running ? '■ Стоп' : '▶ Задача'),
      ),
    );
  }
  return block;
}

function card(v: ViewState): HTMLElement {
  const modeSeg = h(
    'div',
    { class: 'seg' },
    h('button', { class: v.mode === 'work' ? 'active' : '', onclick: () => void api.setMode('work') }, 'Работа'),
    h('button', { class: v.mode === 'vacation' ? 'active' : '', onclick: () => void api.setMode('vacation') }, 'Отпуск'),
  );
  const head = h('div', { class: 'card-head' }, h('span', { class: 'title' }, 'Лимиты', api.isDemo ? h('span', { class: 'chip', style: 'margin-left:6px' }, 'демо') : null), modeSeg);
  draggable(head);
  const muted = settings?.sounds.muted ?? false;
  const actions = h(
    'div',
    { class: 'actions' },
    refreshButton('↻'),
    h('button', { onclick: () => void api.openDashboard() }, 'Дашборд'),
    h('button', { title: 'Включить или выключить звуки', onclick: () => void api.updateSettings({ sounds: { muted: !muted } }).then((s) => ((settings = s), schedule())) }, muted ? '🔕 Звук выкл' : '🔔 Звук вкл'),
    h('button', { onclick: () => api.widget.hide(), title: 'Скрыть в трей (вернуть — через значок в трее)' }, 'Скрыть'),
  );
  const blocks = v.providers.filter((p) => p.enabled).map((p) => providerBlock(v, p));
  const datalists = [
    h('datalist', { id: 'models' }, ...['Opus', 'Sonnet', 'Haiku'].map((x) => h('option', { value: x }))),
    h('datalist', { id: 'efforts' }, ...['standard', 'extended'].map((x) => h('option', { value: x }))),
  ];
  return h('div', { class: 'card' }, head, ...blocks, actions, ...datalists);
}

// --- отрисовка -----------------------------------------------------------------------------

function render(): void {
  renderPending = false;
  const shell = h('div', { class: 'shell' }, compactRow(view));
  draggable(shell.firstElementChild as HTMLElement, () => void toggle());
  if (expanded && view) shell.append(card(view));
  root.replaceChildren(shell);
  api.widget.setSize(372, Math.ceil(shell.getBoundingClientRect().height) + 2);
}

function schedule(): void {
  // Пока пользователь печатает в поле карточки, перерисовка отложена: иначе потеряется фокус и введённый текст.
  if (busy || document.activeElement instanceof HTMLInputElement) {
    renderPending = true;
    return;
  }
  render();
}

async function toggle(): Promise<void> {
  expanded = !expanded;
  await api.widget.setExpanded(expanded);
  render();
}

window.addEventListener('focusout', () => {
  if (renderPending) setTimeout(schedule, 50);
});

api.onState((s) => {
  view = s;
  void api.getSettings().then((st) => (settings = st));
  schedule();
});
api.onSignal((p) => playSignal(p));
// Windows сообщил, что сеть вернулась (например, после гибернации): не ждём таймера, опрашиваем сразу.
window.addEventListener('online', () => void refreshNow());

void (async () => {
  settings = await api.getSettings();
  expanded = settings.widget.expanded;
  view = await api.getState();
  render();
})();

// Относительное время («сброс через…») идёт и между опросами.
setInterval(() => {
  if (view) schedule();
}, 30_000);
