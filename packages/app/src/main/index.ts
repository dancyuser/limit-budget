import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
} from 'electron';
import {
  DAY,
  FakeProvider,
  UsageSimulator,
  defaultPeakProfile,
  defaultSchedule,
  parseHm,
  zonedToMs,
  type AppMode,
  type PeriodKind,
  type PeriodMode,
  type ProviderId,
  type Schedule,
  type SignalEvent,
  type UsageProvider,
} from '@limit-budget/core';
import { ChatGptProvider, StaticRolloutSource } from '../providers/chatgpt.js';
import { ClaudeProvider } from '../providers/claude.js';
import { codexRolloutFixture } from '../providers/fixtures.js';
import { Store } from '../shared/db.js';
import { seedKnownEvents } from '../shared/knownEvents.js';
import { blocksCsv, daysCsv, modelsCsv, snapshotsCsv } from '../shared/export.js';
import type { LoginResult, ProxyInfo, ProxyTestResult, SignalPayload } from '../shared/ipc.js';
import { describeProxy, effectiveProxy, parseProxy, proxyFromLaunch, type ProxyMode, type ProxySource } from '../shared/proxy.js';
import { UsageService, type ViewState } from '../shared/service.js';
import { ClaudeWebSession } from './claudeSession.js';
import { LoginInputError } from '../shared/loginCookie.js';
import { gaugePng } from './icon.js';
import { runSpike } from './spike.js';

const argv = process.argv;
const DEMO = argv.includes('--demo');
const SMOKE = argv.includes('--smoke');
const smokeDir = (() => {
  const i = argv.indexOf('--smoke-dir');
  return i >= 0 ? argv[i + 1] : join(process.cwd(), 'smoke');
})();
const demoSpeed = (() => {
  const i = argv.indexOf('--demo-speed');
  return i >= 0 ? Number(argv[i + 1]) : 60;
})();

app.setName('LimitBudget');
// Для проверки со снимками экрана: без GPU захват страницы работает и в сеансе без дисплея.
if (SMOKE) app.disableHardwareAcceleration();
app.setPath('userData', join(app.getPath('appData'), DEMO ? 'LimitBudget-demo' : 'LimitBudget'));
const gotLock = DEMO || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// Прокси из ключа запуска или окружения задаётся ещё до готовности Chromium, чтобы ни один запрос не ушёл напрямую.
// Если значение не разобрать, программа не стартует: молча идти в обход прокси нельзя.
let launchProxyError: string | null = null;
try {
  const early = effectiveProxy(argv, process.env, null);
  if (early.source !== 'settings') {
    if (early.proxy.mode === 'fixed') app.commandLine.appendSwitch('proxy-server', early.proxy.rules);
    else if (early.proxy.mode === 'direct') app.commandLine.appendSwitch('no-proxy-server');
  }
} catch (e) {
  launchProxyError = (e as Error).message;
}

const WIDGET_W = 372;
const COMPACT_H = 36;
const preloadPath = join(__dirname, 'preload.js');
const rendererDir = join(__dirname, 'renderer');

let store: Store;
let service: UsageService;
let widget: BrowserWindow | null = null;
let dashboard: BrowserWindow | null = null;
let loginHelp: BrowserWindow | null = null;
let tray: Tray | null = null;
let claudeSession: ClaudeWebSession | null = null;
let lastDesktopTry = 0;
let logFile = '';

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    if (logFile) appendFileSync(logFile, line + '\n');
  } catch {
    /* журнал необязателен */
  }
}

/** Автозапуск: из установленного приложения — как есть, из исходников — через electron.exe с путём к приложению. */
function applyAutostart(openAtLogin: boolean): void {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin });
  else app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: [app.getAppPath()] });
}

// --- прокси --------------------------------------------------------------------------------

let currentProxy: { proxy: ProxyMode; source: ProxySource; raw: string } = { proxy: { mode: 'system' }, source: 'settings', raw: '' };

function sessionsToProxy(): Electron.Session[] {
  return [session.defaultSession, claudeSession?.ses].filter((s): s is Electron.Session => !!s);
}

/** Применяет прокси ко всем сессиям Chromium (вход и запросы к claude.ai идут через сессию persist:claude). */
async function applyProxy(sel: typeof currentProxy): Promise<void> {
  currentProxy = sel;
  const p = sel.proxy;
  const config: Electron.ProxyConfig =
    p.mode === 'fixed'
      ? { mode: 'fixed_servers', proxyRules: p.rules, proxyBypassRules: '<local>' }
      : p.mode === 'direct'
        ? { mode: 'direct' }
        : { mode: 'system' };
  for (const s of sessionsToProxy()) {
    await s.setProxy(config);
    await s.closeAllConnections(); // уже открытые соединения не должны пережить смену пути
  }
  await claudeSession?.reloadPage();
  log(`прокси: ${describeProxy(p)} (${sel.source === 'launch' ? 'ключ запуска' : sel.source === 'env' ? 'LIMIT_BUDGET_PROXY' : 'настройки'})`);
}

async function proxyInfo(): Promise<ProxyInfo> {
  const ses = claudeSession?.ses ?? session.defaultSession;
  return {
    raw: currentProxy.raw,
    source: currentProxy.source,
    display: describeProxy(currentProxy.proxy),
    resolved: await ses.resolveProxy('https://claude.ai/'),
    overridesSettings: currentProxy.source !== 'settings',
  };
}

/** Проверка связи с claude.ai по текущему пути. Cloudflare отдаёт на /cdn-cgi/trace код страны выхода; адрес не сохраняется. */
/** Один запрос тем же путём, каким ходят окна приложения; любой HTTP-ответ считается «дошло». */
async function probe(ses: Electron.Session, url: string): Promise<{ reachable: boolean; status?: number; ms: number; text?: string; error?: string }> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await ses.fetch(url, { signal: ac.signal });
    return { reachable: true, status: r.status, ms: Date.now() - t0, text: await r.text() };
  } catch (e) {
    return { reachable: false, ms: Date.now() - t0, error: ac.signal.aborted ? 'нет ответа за 12 секунд' : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection(): Promise<ProxyTestResult> {
  const ses = claudeSession?.ses ?? session.defaultSession;
  const resolved = await ses.resolveProxy('https://claude.ai/');
  const [claude, google] = await Promise.all([probe(ses, 'https://claude.ai/cdn-cgi/trace'), probe(ses, 'https://accounts.google.com/')]);
  return {
    reachable: claude.reachable,
    status: claude.status,
    ms: claude.ms,
    resolved,
    country: claude.text ? /^loc=([A-Z]{2})$/m.exec(claude.text)?.[1] : undefined,
    error: claude.error,
    google: { reachable: google.reachable, status: google.status, ms: google.ms, error: google.error },
    windows: await claudeSession?.describeWindows(),
  };
}

function describeTest(r: ProxyTestResult): string {
  const claude = r.reachable
    ? `claude.ai отвечает (HTTP ${r.status}) за ${r.ms} мс${r.country ? `, страна выхода ${r.country}` : ''}`
    : `claude.ai недоступен: ${r.error}`;
  const google = r.google ? (r.google.reachable ? `; Google отвечает (HTTP ${r.google.status}) за ${r.google.ms} мс` : `; Google недоступен: ${r.google.error}`) : '';
  return claude + google;
}

async function networkReport(): Promise<{ lines: string[]; summary: string }> {
  const info = await proxyInfo();
  const t = await testConnection();
  const src = { launch: 'ключ запуска --proxy', env: 'переменная LIMIT_BUDGET_PROXY', settings: 'настройки' }[info.source];
  return {
    lines: [
      `Прокси: ${info.display} (${src})`,
      `Chromium выбирает для https://claude.ai: ${info.resolved}`,
      `Связь с claude.ai: ${describeTest(t)}`,
      ...(t.windows?.length ? [`Открытые окна claude.ai: ${t.windows.map((w) => `${w.kind} ${w.host} → ${w.proxy}`).join('; ')}`] : []),
    ],
    summary: `Сеть: прокси ${info.display}; ${describeTest(t)}${t.reachable ? '' : '. Задайте порт: трей → «Настроить прокси (порт)…»'}`,
  };
}

// --- провайдеры ----------------------------------------------------------------------------

/** Виртуальные часы демо-режима: время идёт быстрее, чтобы сигналы и графики было видно за минуту. */
function makeClock(): () => number {
  if (!DEMO) return Date.now;
  // Фиксированный будний день в рабочем блоке, чтобы демо выглядело одинаково в любой день.
  const base = zonedToMs('2026-11-03', parseHm('10:29'), 'UTC+3');
  const t0 = Date.now();
  return () => base + (Date.now() - t0) * demoSpeed;
}

function buildProviders(clock: () => number): UsageProvider[] {
  const codex = new ChatGptProvider(new StaticRolloutSource(() => codexRolloutFixture(clock())), { source: 'codex-fixture' });
  if (DEMO) {
    const start = clock() - 14 * DAY;
    const sim = new UsageSimulator({
      start,
      weekResetsAt: zonedToMs('2026-10-26', parseHm('10:00'), 'UTC+3'),
      schedule: defaultSchedule(),
      peak: defaultPeakProfile(),
      seed: 7,
      ratePerActiveMinute: 0.4,
    });
    // История за две недели одним куском; дальше симулятор продолжает идти за виртуальными часами.
    const history = sim.advance(clock());
    const rows = history.flatMap((t) => [
      { ts: t.ts, provider: 'claude' as const, window: '5h' as const, bucket: 'all' as const, usedPct: t.u5h ?? 0, resetsAt: t.r5h, source: 'demo' },
      { ts: t.ts, provider: 'claude' as const, window: '7d' as const, bucket: 'all' as const, usedPct: t.u7d ?? 0, resetsAt: t.r7d, source: 'demo' },
    ]);
    for (let i = 0; i < rows.length; i += 20000) store.insertSnapshots(rows.slice(i, i + 20000));
    return [FakeProvider.simulated(sim, clock), codex];
  }
  claudeSession = new ClaudeWebSession(log);
  const claude = new ClaudeProvider(claudeSession, {
    getOrgId: () => service?.settings.claudeOrgId ?? null,
    setOrgId: (id) => service.updateSettings({ claudeOrgId: id }),
  });
  return [claude, codex];
}

// --- окна ----------------------------------------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  for (const w of [widget, dashboard]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function visibleBounds(x: number, y: number, w: number, h: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + 40 >= a.x && y >= a.y && x + 40 <= a.x + a.width && y + 20 <= a.y + a.height && w > 0 && h > 0;
  });
}

function defaultWidgetPosition(w: number): { x: number; y: number } {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - w - 16, y: a.y + 16 };
}

function saveWidgetBounds(): void {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const displayId = screen.getDisplayMatching(b).id;
  service.updateSettings({ widget: { bounds: { x: b.x, y: b.y, displayId } } });
}

/** После смены монитора или высоты карточки возвращает виджет в видимую область. */
function keepOnScreen(): void {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  if (!visibleBounds(b.x, b.y, b.width, b.height)) {
    const p = defaultWidgetPosition(b.width);
    widget.setPosition(p.x, p.y);
    return;
  }
  const y = Math.min(Math.max(b.y, a.y), a.y + a.height - b.height);
  if (y !== b.y) widget.setPosition(b.x, y);
}

function createWidget(): void {
  const s = service.settings.widget;
  const saved = s.bounds;
  const pos = saved && visibleBounds(saved.x, saved.y, WIDGET_W, COMPACT_H) ? { x: saved.x, y: saved.y } : defaultWidgetPosition(WIDGET_W);
  widget = new BrowserWindow({
    width: WIDGET_W,
    height: COMPACT_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: s.alwaysOnTop,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: DEMO ? ['--demo'] : [],
    },
  });
  lockDown(widget);
  if (s.alwaysOnTop) widget.setAlwaysOnTop(true, 'screen-saver');
  widget.setOpacity(s.opacity);
  if (s.clickThrough) widget.setIgnoreMouseEvents(true, { forward: true });
  void widget.loadFile(join(rendererDir, 'widget.html'));
  widget.once('ready-to-show', () => widget?.showInactive());
  widget.on('closed', () => (widget = null));
  widget.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log(`[widget:${e.level}] ${e.message}`);
  });
}

function openDashboard(tab?: string): void {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show();
    dashboard.focus();
    if (tab) dashboard.webContents.send('dashboard:tab', tab);
    return;
  }
  dashboard = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: 'Виджет лимитов — дашборд',
    autoHideMenuBar: true,
    backgroundColor: '#14161b',
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, additionalArguments: DEMO ? ['--demo'] : [] },
  });
  lockDown(dashboard);
  void dashboard.loadFile(join(rendererDir, 'dashboard.html'), { hash: tab ?? '' });
  dashboard.on('closed', () => (dashboard = null));
  dashboard.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log(`[dashboard:${e.level}] ${e.message}`);
  });
}

/**
 * Окно «Вход в Claude»: основной путь — войти в обычном браузере и перенести cookie sessionKey (входить в Google внутри
 * приложения не нужно); запасной — войти в окне приложения.
 */
function openLoginHelp(): void {
  if (loginHelp && !loginHelp.isDestroyed()) {
    loginHelp.show();
    loginHelp.focus();
    return;
  }
  loginHelp = new BrowserWindow({
    width: 660,
    height: 800,
    title: 'Вход в Claude',
    autoHideMenuBar: true,
    backgroundColor: '#14161b',
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, additionalArguments: DEMO ? ['--demo'] : [] },
  });
  lockDown(loginHelp);
  void loginHelp.loadFile(join(rendererDir, 'login.html'));
  loginHelp.on('closed', () => (loginHelp = null));
}

/** Окна виджета и дашборда показывают только свои файлы: любые переходы и новые окна запрещены. */
function lockDown(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

// --- сигналы -------------------------------------------------------------------------------

function payloadFor(provider: ProviderId, event: SignalEvent): SignalPayload {
  const sounds = service.settings.sounds;
  return { provider, event, sound: sounds.perKind[event.kind], volume: sounds.volume, muted: sounds.muted };
}

function onSignal(provider: ProviderId, event: SignalEvent): void {
  log(`сигнал ${event.kind}: ${event.message}`);
  // Звук играет окно виджета; он звучит в любое время, включая обед и часы вне рабочих окон.
  widget?.webContents.send('signal', payloadFor(provider, event));
  if (service.settings.notifications && Notification.isSupported()) {
    new Notification({
      title: event.severity === 'exceeded' ? 'Лимит превышен' : event.severity === 'warning' ? 'Внимание: лимит' : 'Виджет лимитов',
      body: event.message,
      silent: true, // звук уже проигран виджетом
    }).show();
  }
}

// --- трей ----------------------------------------------------------------------------------

function trayColor(view: ViewState): [number, number, number] {
  const p = view.providers.find((x) => x.id === 'claude');
  const b = p?.budget;
  if (!b || p?.status !== 'ok') return [140, 146, 160];
  if (b.exceeded) return [232, 80, 80];
  if (b.status === 'above') return [240, 168, 60];
  return [78, 200, 130];
}

function updateTray(view: ViewState): void {
  if (!tray) return;
  const p = view.providers.find((x) => x.id === 'claude');
  const frac = (p?.tick?.u7d ?? 0) / 100;
  tray.setImage(nativeImage.createFromBuffer(gaugePng(32, frac, trayColor(view))));
  const b = p?.budget;
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);
  tray.setToolTip(
    p?.tick
      ? `Claude · 5ч ${fmt(p.tick.u5h)} · доступно ${fmt(b?.available)} · нед ${fmt(p.tick.u7d)} / ${fmt(b?.target)}${view.mode === 'vacation' ? ' · отпуск' : ''}`
      : 'Виджет лимитов',
  );
}

function buildTrayMenu(): Menu {
  const s = service.settings;
  return Menu.buildFromTemplate([
    { label: 'Показать / скрыть виджет', click: () => (widget?.isVisible() ? widget.hide() : widget?.showInactive()) },
    { label: 'Открыть дашборд', click: () => openDashboard() },
    { type: 'separator' },
    {
      label: service.mode === 'vacation' ? 'Режим: Отпуск (вернуться к работе)' : 'Режим: Работа (включить отпуск)',
      click: () => {
        service.setMode(service.mode === 'vacation' ? 'work' : 'vacation');
        tray?.setContextMenu(buildTrayMenu());
      },
    },
    {
      label: 'Звуки включены',
      type: 'checkbox',
      checked: !s.sounds.muted,
      click: (i) => {
        service.updateSettings({ sounds: { muted: !i.checked } });
      },
    },
    {
      label: 'Пропускать клики через виджет',
      type: 'checkbox',
      checked: s.widget.clickThrough,
      click: (i) => {
        service.updateSettings({ widget: { clickThrough: i.checked } });
        widget?.setIgnoreMouseEvents(i.checked, { forward: true });
      },
    },
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: s.startWithWindows,
      click: (i) => {
        service.updateSettings({ startWithWindows: i.checked });
        applyAutostart(i.checked);
      },
    },
    { type: 'separator' },
    { label: `Прокси: ${describeProxy(currentProxy.proxy)}`, enabled: false },
    { label: 'Настроить прокси (порт)…', click: () => openDashboard('settings:proxy') },
    {
      label: 'Проверить связь с claude.ai',
      click: () => {
        void testConnection().then((r) => dialog.showMessageBox({ type: r.reachable ? 'info' : 'warning', title: 'Связь с claude.ai', message: describeTest(r), detail: `Прокси: ${describeProxy(currentProxy.proxy)}\nChromium выбирает: ${r.resolved}` }));
      },
    },
    { label: 'Войти в Claude…', click: () => claudeSession?.openLogin() },
    { label: 'Войти через Claude Desktop…', click: () => void runDesktopImport() },
    { label: 'Вход: другой способ…', click: () => openLoginHelp() },
    { label: 'Шаг 0: спайк источников данных', click: () => void doSpike() },
    { label: 'Открыть папку данных', click: () => void shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]);
}

async function doSpike() {
  if (!claudeSession) return { file: '', summary: ['В демо-режиме спайк недоступен'] };
  const web = claudeSession;
  const result = await runSpike({
    fetcher: web,
    describeCookies: () => web.describeCookies(),
    hasSession: () => web.hasSessionCookie(),
    networkReport,
    outDir: join(app.getPath('userData'), 'spike'),
    log,
  });
  void dialog.showMessageBox({ type: 'info', title: 'Шаг 0: спайк', message: result.summary.join('\n'), detail: `Отчёт: ${result.file}` });
  void shell.showItemInFolder(result.file);
  return result;
}

// --- запасной путь входа: сессия Claude Desktop -------------------------------------------
//
// Автоматически — только если включено настройкой (desktopSessionFallback, выключена по умолчанию) и не чаще
// раза в 6 часов. По явному нажатию кнопки («Через Claude Desktop…») работает всегда, без этих ограничений —
// нажатие кнопки само по себе и есть согласие на попытку.

/** Ручной запуск из трея: как нажатие кнопки в окне входа, только с итогом в диалоге. */
async function runDesktopImport(): Promise<void> {
  if (!claudeSession) return;
  const r = await claudeSession.importFromDesktop().catch((e) => ({ ok: false, message: (e as Error).message, cloudflare: false }));
  await dialog.showMessageBox({ type: r.ok ? 'info' : 'warning', title: 'Вход через Claude Desktop', message: r.message });
}

async function tryDesktopFallback(): Promise<void> {
  if (!claudeSession || !service.settings.desktopSessionFallback) return;
  if (Date.now() - lastDesktopTry < 6 * 3_600_000) return;
  lastDesktopTry = Date.now();
  const r = await claudeSession.importFromDesktop().catch((e) => ({ ok: false, message: (e as Error).message }));
  log(`сессия Claude Desktop (автоматически): ${r.message}`);
  if (r.ok) void service.pollOnce();
}

// --- IPC -----------------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('state:get', () => service.getViewState());
  ipcMain.handle('settings:get', () => service.settings);
  ipcMain.handle('proxy:get', () => proxyInfo());
  ipcMain.handle('proxy:test', () => testConnection());
  ipcMain.handle('settings:update', async (_e, patch) => {
    // Неверный адрес прокси отвергается до сохранения: прежняя рабочая настройка не теряется.
    const proxyChanged = patch && typeof patch === 'object' && 'proxy' in patch;
    if (proxyChanged) parseProxy((patch as { proxy: string | null }).proxy);
    const next = service.updateSettings(patch);
    // Ключ запуска и переменная окружения важнее настроек: тогда сохранённое значение просто ждёт своего часа.
    if (proxyChanged && currentProxy.source === 'settings') {
      await applyProxy({ proxy: parseProxy(next.proxy), source: 'settings', raw: next.proxy ?? '' });
    }
    widget?.setOpacity(next.widget.opacity);
    widget?.setAlwaysOnTop(next.widget.alwaysOnTop, 'screen-saver');
    widget?.setIgnoreMouseEvents(next.widget.clickThrough, { forward: true });
    applyAutostart(next.startWithWindows);
    tray?.setContextMenu(buildTrayMenu());
    return next;
  });
  ipcMain.handle('schedule:get', () => service.schedule);
  ipcMain.handle('schedule:set', (_e, s: Schedule) => service.setSchedule(s));
  ipcMain.handle('mode:set', (_e, m: AppMode) => {
    service.setMode(m);
    tray?.setContextMenu(buildTrayMenu());
  });
  ipcMain.handle('stats:get', (_e, p: ProviderId, k: PeriodKind, m: PeriodMode) => service.getStats(p, k, m));
  ipcMain.handle('notes:list', () => service.notes());
  ipcMain.handle('notes:add', (_e, text: string, p: ProviderId | null) => service.addNote(text, p));
  ipcMain.handle('notes:delete', (_e, id: number) => store.deleteNote(id));
  ipcMain.handle('anomalies:list', () => service.anomalies());
  ipcMain.handle('model:set', (_e, p: ProviderId, model: string | null, effort: string | null) => service.setModel(p, model, effort));
  ipcMain.handle('task:start', (_e, p: ProviderId) => service.startTask(p));
  ipcMain.handle('task:stop', (_e, p: ProviderId) => service.stopTask(p));
  // Основной путь входа: открывает окно с claude.ai, вход автоматически обнаруживается и окно закрывается само.
  ipcMain.handle('login:open', () => claudeSession?.openLogin());
  ipcMain.handle('login:help', () => openLoginHelp());
  ipcMain.handle('login:in-app', () => claudeSession?.openLogin());
  ipcMain.handle('login:page', () => claudeSession?.openPage());
  // Открывается только фиксированный адрес claude.ai в браузере по умолчанию; адрес из страницы не принимается.
  ipcMain.handle('login:browser', () => shell.openExternal('https://claude.ai/'));
  ipcMain.handle('login:import', async (_e, text: string): Promise<LoginResult> => {
    if (!claudeSession) return { ok: false, message: 'В демо-режиме вход недоступен.' };
    try {
      const r = await claudeSession.importSessionKey(String(text ?? ''));
      if (r.ok) setTimeout(() => loginHelp?.close(), 2500);
      return r;
    } catch (e) {
      if (e instanceof LoginInputError) return { ok: false, message: e.message };
      log(`вход через cookie: ${(e as Error).message}`);
      return { ok: false, message: 'Не удалось сохранить cookie. Подробности в журнале.' };
    }
  });
  // По явному нажатию — без ограничений автоматического пути (настройка, 6-часовой интервал).
  ipcMain.handle('login:desktop', async (): Promise<LoginResult> => {
    if (!claudeSession) return { ok: false, message: 'В демо-режиме вход недоступен.' };
    try {
      const r = await claudeSession.importFromDesktop();
      if (r.ok) setTimeout(() => loginHelp?.close(), 2500);
      return r;
    } catch (e) {
      log(`вход через Claude Desktop: ${(e as Error).message}`);
      return { ok: false, message: `Не удалось прочитать сессию Claude Desktop: ${(e as Error).message}` };
    }
  });
  ipcMain.handle('dashboard:open', (_e, tab?: string) => openDashboard(tab));
  ipcMain.handle('spike:run', () => doSpike());
  ipcMain.handle('sound:test', (_e, kind: string) => {
    const event: SignalEvent = {
      kind: kind as SignalEvent['kind'],
      severity: kind === 'limit-exceeded' ? 'exceeded' : kind === 'over-trajectory' || kind === 'window-ends-early' || kind === 'low-available' ? 'warning' : 'quiet',
      ts: Date.now(),
      message: 'Проверка звука',
      reminder: false,
    };
    widget?.webContents.send('signal', { ...payloadFor('claude', event), muted: false });
  });
  ipcMain.handle('sound:pick', async () => {
    const r = await dialog.showOpenDialog({ title: 'Звуковой файл', filters: [{ name: 'Звук', extensions: ['wav', 'mp3', 'ogg'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('export:data', async (_e, p: ProviderId, what: 'snapshots' | 'days' | 'models', format: 'csv' | 'json', period: PeriodKind, mode: PeriodMode) => {
    const r = await dialog.showSaveDialog({ title: 'Экспорт', defaultPath: `limits-${p}-${what}.${format}` });
    if (r.canceled || !r.filePath) return null;
    const now = Date.now();
    let text: string;
    if (what === 'snapshots') {
      const ticks = store.getTicks(p, now - 62 * DAY, now);
      text = format === 'json' ? JSON.stringify(ticks, null, 2) : snapshotsCsv(ticks);
    } else {
      const stats = service.getStats(p, period, mode);
      const data = what === 'days' ? stats.days : stats.models;
      text = format === 'json' ? JSON.stringify(data, null, 2) : what === 'days' ? daysCsv(stats) : modelsCsv(stats);
    }
    writeFileSync(r.filePath, '﻿' + text, 'utf8');
    return r.filePath;
  });

  // Перетаскивание виджета: позицию считает main, чтобы не было дрожания при движении окна.
  let dragOrigin: { x: number; y: number } | null = null;
  ipcMain.on('widget:drag-start', () => {
    if (widget) {
      const [x, y] = widget.getPosition();
      dragOrigin = { x, y };
    }
  });
  ipcMain.on('widget:drag-move', (_e, dx: number, dy: number) => {
    if (widget && dragOrigin) widget.setPosition(Math.round(dragOrigin.x + dx), Math.round(dragOrigin.y + dy));
  });
  ipcMain.on('widget:drag-end', () => {
    dragOrigin = null;
    keepOnScreen();
    saveWidgetBounds();
  });
  ipcMain.on('widget:set-size', (_e, w: number, h: number) => {
    if (!widget) return;
    widget.setContentSize(Math.round(w), Math.max(COMPACT_H, Math.round(h)));
    keepOnScreen();
  });
  ipcMain.handle('widget:set-expanded', (_e, expanded: boolean) => {
    service.updateSettings({ widget: { expanded } });
  });
  ipcMain.on('widget:hide', () => widget?.hide());
}

// --- демо-проверка (smoke): скриншоты и ошибки консоли -------------------------------------

async function runSmoke(): Promise<void> {
  mkdirSync(smokeDir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: [] as string[] };
  const step = (s: string) => (report.steps as string[]).push(s);
  const shot = async (win: BrowserWindow | null, name: string) => {
    if (!win || win.isDestroyed()) return step(`нет окна для ${name}`);
    // Первый кадр иногда ещё не нарисован: повторяем несколько раз.
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const img = await win.webContents.capturePage();
        writeFileSync(join(smokeDir, `${name}.png`), img.toPNG());
        return step(`снимок ${name}`);
      } catch (e) {
        if (attempt === 4) return step(`снимок ${name} не удался: ${(e as Error).message}`);
        await wait(700);
      }
    }
  };
  const exec = (win: BrowserWindow | null, js: string) => win?.webContents.executeJavaScript(js) ?? Promise.resolve(null);
  const waitFor = async (win: BrowserWindow | null, selector: string, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await exec(win, `!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await wait(250);
    }
    step(`не дождались ${selector}`);
    return false;
  };
  try {
    await waitFor(widget, '[data-testid=compact]');
    await wait(3500);
    await shot(widget, '01-widget-compact');
    await exec(widget, `document.querySelector('[data-testid=compact]').click()`);
    await wait(1200);
    await shot(widget, '02-widget-expanded');
    report.widgetBounds = widget?.getBounds();
    report.widgetText = await exec(widget, `document.body.innerText`);
    openDashboard();
    for (const tab of ['overview', 'models', 'heatmap', 'journal', 'settings']) {
      if (!(await waitFor(dashboard, `[data-tab=${tab}]`))) continue;
      await exec(dashboard, `document.querySelector('[data-tab=${tab}]').click()`);
      await wait(1200);
      await shot(dashboard, `03-dashboard-${tab}`);
    }
    // Панель прокси: показать, а при явно заданном прокси ещё и нажать «Применить и проверить» через интерфейс.
    await exec(dashboard, `document.querySelector('[data-testid=proxy-panel]').scrollIntoView({ block: 'center' })`);
    // --smoke-proxy-ui: ввести порт в полях настроек, как это сделает пользователь, и нажать «Применить и проверить».
    if (argv.includes('--smoke-proxy-ui')) {
      await exec(
        dashboard,
        `(() => {
          const set = (id, v) => { const el = document.querySelector('[data-testid=' + id + ']'); el.value = v; el.dispatchEvent(new Event('change')); };
          set('proxy-mode', 'custom'); set('proxy-scheme', 'socks5'); set('proxy-host', '127.0.0.1'); set('proxy-port', '10808');
        })()`,
      );
    }
    if (currentProxy.source !== 'settings' || argv.includes('--smoke-proxy-ui')) {
      await exec(dashboard, `document.querySelector('[data-testid=proxy-apply]').click()`);
      for (let i = 0; i < 40; i++) {
        const t = String((await exec(dashboard, `document.querySelector('[data-testid=proxy-state]').innerText`)) ?? '');
        if (/Связь есть|Связи нет|Не применено/.test(t)) break;
        await wait(500);
      }
    }
    report.proxyPanel = await exec(dashboard, `document.querySelector('[data-testid=proxy-state]').innerText`);
    await wait(400);
    await shot(dashboard, '04-dashboard-proxy');
    report.dashboardText = String((await exec(dashboard, `document.body.innerText`)) ?? '').slice(0, 1500);
    // Окно входа: по умолчанию показывает автоматический способ (без ввода чего-либо вручную).
    openLoginHelp();
    if (await waitFor(loginHelp, '[data-testid=open-login-window]')) {
      await wait(500);
      await shot(loginHelp, '05-login');
      // Кнопка «Через Claude Desktop»: на этой машине его данных для входа нет, поэтому ожидаем понятный отказ.
      await exec(loginHelp, `document.querySelector('[data-testid=try-desktop]').click()`);
      for (let i = 0; i < 30; i++) {
        await wait(500);
        const t = String((await exec(loginHelp, `document.querySelector('[data-testid=desktop-result]').innerText`)) ?? '');
        if (t && t !== 'Проверяю…') break;
      }
      report.desktopImport = await exec(loginHelp, `document.querySelector('[data-testid=desktop-result]').innerText`);
      await shot(loginHelp, '05a-login-desktop');
      // Запасной способ скрыт за <details>: открываем его, чтобы проверить неверный ввод и заведомо неверную cookie.
      await exec(loginHelp, `document.querySelector('[data-testid=fallback-summary]').click()`);
      await wait(300);
      await shot(loginHelp, '05b-login-fallback');
      const type = (v: string) =>
        exec(loginHelp, `(() => { const i = document.querySelector('[data-testid=session-key]'); i.value = ${JSON.stringify(v)}; document.querySelector('[data-testid=login-submit]').click(); })()`);
      const resultText = () => exec(loginHelp, `document.querySelector('[data-testid=login-result]').innerText`);
      await type('abc');
      await wait(900);
      report.loginBadInput = await resultText();
      if (claudeSession) {
        await type('sk-ant-sid01-' + 'x'.repeat(60));
        for (let i = 0; i < 60; i++) {
          await wait(500);
          const t = String((await resultText()) ?? '');
          if (t && t !== 'Проверяю…') break;
        }
        report.loginFakeKey = await resultText();
        report.cookieAfterFake = await claudeSession.hasSessionCookie();
        await shot(loginHelp, '06-login-result');
      }
    }
    // Проверка User-Agent окна claude.ai (persist:claude): без токена Electron, иначе Google и подобные
    // сайты отказывают во входе внутри встроенного браузера.
    if (claudeSession) report.loginUserAgent = claudeSession.ses.getUserAgent();
    // Окно входа и всплывающее окно Google должны идти через прокси. Контрольный опыт: сессия без прокси до claude.ai не доходит.
    if (claudeSession && argv.includes('--smoke-windows')) {
      const web = claudeSession;
      const pageOf = (host: string) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(host));
      web.openLogin();
      for (let i = 0; i < 60 && !pageOf('claude.ai'); i++) await wait(500);
      await wait(1500);
      const loginWin = pageOf('claude.ai');
      report.loginWindow = loginWin ? { url: new URL(loginWin.webContents.getURL()).host, title: loginWin.getTitle() } : null;
      // Как это делает кнопка «Войти через Google» на странице: window.open из страницы claude.ai
      await exec(loginWin ?? null, `window.open('https://accounts.google.com/', '_blank', 'popup,width=520,height=720'); true`);
      for (let i = 0; i < 40 && !pageOf('google.com'); i++) await wait(500);
      await wait(1500);
      const popup = pageOf('google.com');
      report.googlePopup = popup
        ? { host: new URL(popup.webContents.getURL()).host, title: popup.getTitle(), sameSession: popup.webContents.session === web.ses }
        : null;
      report.windows = await web.describeWindows();
      report.connection = await testConnection();
      // Контроль: тот же запрос из сессии без прокси.
      const direct = session.fromPartition('probe-direct');
      await direct.setProxy({ mode: 'direct' });
      report.directProbe = await probe(direct, 'https://claude.ai/cdn-cgi/trace').then((r) => ({ reachable: r.reachable, error: r.error, ms: r.ms }));
      for (const w of BrowserWindow.getAllWindows()) if (w !== dashboard && w !== widget && w !== loginHelp && !w.isDestroyed()) w.destroy();
    }
    // Сигнал: звук играет в окне виджета; проверяем, что весь путь проходит без исключений.
    onSignal('claude', { kind: 'limit-exceeded', severity: 'exceeded', ts: Date.now(), message: 'Проверка (smoke)', reminder: false });
    await wait(800);
    report.audio = await exec(widget, `window.__lastSound || null`);
    report.proxy = await proxyInfo();
    // Сетевую проверку делаем только если прокси задан явно: иначе проверка не нужна и лишнего трафика быть не должно.
    if (currentProxy.source !== 'settings') report.network = await testConnection();
    report.state = service.getViewState().providers.map((p) => ({ id: p.id, status: p.status, tick: p.tick, available: p.budget?.available, target: p.budget?.target }));
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = (e as Error).message;
  }
  writeFileSync(join(smokeDir, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}

/**
 * Окно входа не имеет смысла, пока claude.ai недоступен (например, нужен прокси, а он не задан): вместо пустой
 * страницы с ошибкой предлагаем сразу указать порт прокси.
 */
async function startLoginFlow(web: ClaudeWebSession): Promise<void> {
  const t = await testConnection();
  if (t.reachable) {
    web.openLogin();
    return;
  }
  const configured = currentProxy.proxy.mode === 'fixed';
  const r = await dialog.showMessageBox({
    type: 'warning',
    title: 'Нет связи с claude.ai',
    message: configured ? `claude.ai недоступен через прокси ${describeProxy(currentProxy.proxy)}.` : 'claude.ai недоступен напрямую.',
    detail:
      'Если у вас включён прокси или VPN (например, v2rayN / xray), укажите его порт: обычно SOCKS5, адрес 127.0.0.1, порт 10808.\n\n' +
      `Что видит приложение: ${describeTest(t)}.`,
    buttons: ['Указать прокси', 'Всё равно открыть вход', 'Позже'],
    defaultId: 0,
    cancelId: 2,
  });
  if (r.response === 0) openDashboard('settings:proxy');
  else if (r.response === 1) web.openLogin();
}

// --- запуск --------------------------------------------------------------------------------

app.on('second-instance', (_e, args) => {
  // Повторный запуск с --proxy переключает уже работающий экземпляр, а не теряется молча.
  try {
    const l = proxyFromLaunch(args, {});
    if (l && l.source === 'launch') void applyProxy({ proxy: parseProxy(l.value), source: 'launch', raw: l.value }).then(() => tray?.setContextMenu(buildTrayMenu()));
  } catch (e) {
    dialog.showErrorBox('Неверный адрес прокси', (e as Error).message);
  }
  widget?.showInactive();
});

app.on('window-all-closed', () => {
  /* живём в трее */
});

void app.whenReady().then(async () => {
  if (!gotLock) return;
  if (launchProxyError) {
    dialog.showErrorBox('Неверный адрес прокси', `${launchProxyError}\n\nПримеры: --proxy 10808, --proxy socks5://127.0.0.1:10808, --proxy http://127.0.0.1:10809, --proxy off`);
    app.exit(2);
    return;
  }
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  logFile = join(dataDir, 'widget.log');
  const dbPath = join(dataDir, DEMO ? 'demo.sqlite' : 'usage.sqlite');
  if (DEMO) for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) if (existsSync(f)) rmSync(f);
  store = new Store(dbPath);
  seedKnownEvents(store);
  const clock = makeClock();
  // Проверка входа через cookie в демо-режиме: сессия создаётся, но опроса claude.ai нет.
  if (DEMO && argv.includes('--smoke-claude')) claudeSession = new ClaudeWebSession(log);
  service = new UsageService({ store, providers: buildProviders(clock), clock });
  if (DEMO) service.updateSettings({ providers: { chatgpt: { enabled: true } }, signals: { reminderMinutes: 0 } });

  service.on('state', (view) => {
    broadcast('state', view);
    updateTray(view);
    const p = view.providers.find((x) => x.id === 'claude');
    if (p?.status === 'needs-login') void tryDesktopFallback();
  });
  service.on('signal', ({ provider, event }) => onSignal(provider, event));
  service.on('log', log);
  service.on('anomaly', (a) => log(`возможное изменение лимитов: ${a.note}`));

  // Прокси применяется до того, как что-либо пойдёт в сеть: до окна входа и первого опроса.
  try {
    await applyProxy(effectiveProxy(argv, process.env, service.settings.proxy));
  } catch (e) {
    log(`сохранённый адрес прокси неверен (${(e as Error).message}); использую системные настройки`);
    await applyProxy({ proxy: { mode: 'system' }, source: 'settings', raw: '' });
  }

  registerIpc();
  createWidget();
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);

  tray = new Tray(nativeImage.createFromBuffer(gaugePng(32, 0, [140, 146, 160])));
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => (widget?.isVisible() ? widget.hide() : widget?.showInactive()));
  updateTray(service.getViewState());

  if (DEMO) {
    // В демо опрос идёт раз в секунду реального времени = минута виртуального.
    setInterval(() => void service.pollOnce(), 1000);
    if (SMOKE) void runSmoke();
    return;
  }

  applyAutostart(service.settings.startWithWindows);
  if (claudeSession) {
    const web = claudeSession;
    web.onLoggedIn = () => {
      void service.pollOnce();
      loginHelp?.close();
    };
    await web.persistSessionCookies().catch(() => 0);
    web.startKeepAlive();
    // Первый запуск: сразу окно входа, без промежуточной страницы — вход занимает один шаг.
    if (!(await web.hasSessionCookie())) setTimeout(() => void startLoginFlow(web), 1500);
  }
  service.start();
});

app.on('before-quit', () => {
  service?.stop();
  claudeSession?.stop();
  try {
    store?.close();
  } catch {
    /* уже закрыта */
  }
});

