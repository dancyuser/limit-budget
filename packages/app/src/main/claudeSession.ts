// Вход в claude.ai один раз в окне виджета и запросы изнутри страницы.
//
// Постоянная сессия Electron (partition persist:claude) хранит cookie на диске. По справке Anthropic вход создаёт
// сессию на 28 дней, а любое действие на claude.ai продлевает её каждый час, поэтому виджет обращается к странице
// при каждом опросе и раз в час перезагружает её. Запросы идут из контекста страницы, потому что внешним
// клиентам мешает проверка Cloudflare.
//
// Окно входа (openLogin) полностью автоматическое: пользователь просто входит как обычно (включая через Google),
// а приложение само замечает появившуюся cookie сессии и закрывает окно. Строка User-Agent очищена от токенов
// Electron/имени приложения (см. ../shared/userAgent.ts), иначе такие сайты, как Google, отказывают во входе
// во встроенном браузере, определяя его именно по этим токенам.
import { BrowserWindow, app, session, type Session } from 'electron';
import type { PageFetcher } from '../providers/claude.js';
import { extractSessionKey } from '../shared/loginCookie.js';
import { desktopUserAgent } from '../shared/userAgent.js';
import { importClaudeDesktopCookies } from './desktopSession.js';

const ORIGIN = 'https://claude.ai';
const PARTITION = 'persist:claude';
const HOUR = 3_600_000;
/** Срок жизни, который проставляется cookie без собственного срока, чтобы вход переживал перезапуск виджета. */
const SESSION_COOKIE_TTL_S = 28 * 24 * 3600;

export class ClaudeWebSession implements PageFetcher {
  private hidden: BrowserWindow | null = null;
  private loginWin: BrowserWindow | null = null;
  private loading: Promise<BrowserWindow> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private loginWatch: ReturnType<typeof setInterval> | null = null;
  onLoggedIn: (() => void) | null = null;
  /** Без токенов Electron/x.x.x и имени приложения: некоторые сайты (в т. ч. вход через Google) блокируют
   *  встроенный браузер именно по этим токенам в User-Agent, принимая его за автоматизацию. */
  private readonly userAgent: string;

  constructor(private log: (m: string) => void = () => {}) {
    this.userAgent = desktopUserAgent(this.ses.getUserAgent(), app.getName());
    this.ses.setUserAgent(this.userAgent);
  }

  get ses(): Session {
    return session.fromPartition(PARTITION);
  }

  private applyUserAgent(win: BrowserWindow): void {
    win.webContents.setUserAgent(this.userAgent);
  }

  /** Всплывающие окна входа (Google и т. п.), пока открыты. */
  private popups = new Set<BrowserWindow>();

  /**
   * Окна claude.ai и всплывающие окна входа должны жить в одной сессии (persist:claude): тогда у них общий прокси,
   * общие cookie и одинаковая строка браузера. Всплывающее окно создаётся явно в этой же сессии, а не по умолчанию.
   */
  private configureWindow(win: BrowserWindow): void {
    this.applyUserAgent(win);
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520,
        height: 720,
        autoHideMenuBar: true,
        webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
      },
    }));
    win.webContents.on('did-create-window', (child) => {
      this.popups.add(child);
      child.on('closed', () => this.popups.delete(child));
      this.configureWindow(child);
    });
  }

  /** Какой путь выбирает каждое открытое окно claude.ai (адрес — только хост): для проверки, что все идут через прокси. */
  async describeWindows(): Promise<Array<{ kind: string; host: string; proxy: string }>> {
    const list: Array<[string, BrowserWindow | null]> = [
      ['скрытая страница', this.hidden],
      ['окно входа', this.loginWin],
      ...[...this.popups].map((w): [string, BrowserWindow] => ['всплывающее окно', w]),
    ];
    const out: Array<{ kind: string; host: string; proxy: string }> = [];
    for (const [kind, w] of list) {
      if (!w || w.isDestroyed()) continue;
      const url = w.webContents.getURL();
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        host = '(пусто)';
      }
      out.push({ kind, host, proxy: await w.webContents.session.resolveProxy(url || ORIGIN) });
    }
    return out;
  }

  /** Скрытое окно с залогиненной страницей claude.ai: из него выполняются запросы. */
  private async page(): Promise<BrowserWindow> {
    if (this.hidden && !this.hidden.isDestroyed()) return this.hidden;
    if (!this.loading) {
      this.loading = (async () => {
        const win = new BrowserWindow({
          show: false,
          width: 900,
          height: 700,
          webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, sandbox: true },
        });
        win.on('closed', () => {
          if (this.hidden === win) this.hidden = null;
        });
        this.configureWindow(win);
        try {
          await win.loadURL(`${ORIGIN}/`);
        } catch (e) {
          this.log(`claude.ai не загрузился: ${(e as Error).message}`);
        }
        this.hidden = win;
        return win;
      })().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async fetchJson(path: string): Promise<{ status: number; json: unknown; text?: string }> {
    const win = await this.page();
    const script = `(async () => {
      try {
        const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { status: r.status, json, text: json === null ? text.slice(0, 2000) : undefined };
      } catch (e) {
        return { status: 0, json: null, text: String(e) };
      }
    })()`;
    // Страница могла остаться на чужом адресе (например, после выхода): возвращаем её на claude.ai.
    if (!win.webContents.getURL().startsWith(ORIGIN)) await win.loadURL(`${ORIGIN}/`).catch(() => {});
    return (await win.webContents.executeJavaScript(script, true)) as { status: number; json: unknown; text?: string };
  }

  /** Перезагрузить скрытую страницу (после смены прокси): старые соединения закрыты, новые пойдут по новому пути. */
  async reloadPage(): Promise<void> {
    if (this.hidden && !this.hidden.isDestroyed()) await this.hidden.loadURL(`${ORIGIN}/`).catch(() => {});
  }

  /**
   * Закрыть все соединения сессии и перезагрузить скрытую страницу. После сна и гибернации старые соединения
   * (особенно через прокси) мертвы, и запросы по ним зависают, а не ошибаются сразу; новые пойдут заново.
   */
  async resetConnections(): Promise<void> {
    await this.ses.closeAllConnections().catch(() => {});
    await this.reloadPage();
  }

  /** Раз в час перезагружает страницу (это продлевает сессию) и закрепляет cookie на диске. */
  startKeepAlive(): void {
    if (this.keepAlive) return;
    this.keepAlive = setInterval(() => {
      void this.page().then((w) => w.loadURL(`${ORIGIN}/`).catch(() => {}));
      void this.persistSessionCookies();
    }, HOUR);
  }

  stop(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.loginWatch) clearInterval(this.loginWatch);
    this.hidden?.destroy();
    this.loginWin?.destroy();
  }

  async hasSessionCookie(): Promise<boolean> {
    const cookies = await this.ses.cookies.get({ url: ORIGIN });
    return cookies.some((c) => c.name === 'sessionKey');
  }

  /**
   * Cookie без срока Chromium не пишет на диск, и вход пропал бы после перезапуска. Проставляем срок 28 дней —
   * столько живёт сессия на стороне claude.ai. На шаге 0 проверяется, что вход действительно переживает перезапуск.
   */
  async persistSessionCookies(): Promise<number> {
    const cookies = await this.ses.cookies.get({ url: ORIGIN });
    let n = 0;
    for (const c of cookies) {
      if (!c.session) continue;
      try {
        await this.ses.cookies.set({
          url: ORIGIN,
          name: c.name,
          value: c.value,
          ...(c.hostOnly ? {} : { domain: c.domain }),
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_TTL_S,
        });
        n++;
      } catch (e) {
        this.log(`cookie ${c.name}: ${(e as Error).message}`);
      }
    }
    await this.ses.cookies.flushStore();
    return n;
  }

  /** Окно входа: пользователь входит один раз, дальше виджет работает с сохранённой сессией. */
  openLogin(): void {
    if (this.loginWin && !this.loginWin.isDestroyed()) {
      this.loginWin.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      title: 'Вход в Claude — виджет лимитов',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
    });
    this.loginWin = win;
    this.configureWindow(win);
    void win.loadURL(`${ORIGIN}/login`);
    win.on('closed', () => {
      if (this.loginWin === win) this.loginWin = null;
      if (this.loginWatch) clearInterval(this.loginWatch);
      this.loginWatch = null;
    });
    this.loginWatch = setInterval(async () => {
      if (!(await this.hasSessionCookie())) return;
      // Дадим странице закончить вход, затем закрепим cookie и перезагрузим скрытое окно.
      await new Promise((r) => setTimeout(r, 2500));
      const saved = await this.persistSessionCookies();
      this.log(`вход выполнен, закреплено cookie: ${saved}`);
      if (this.loginWatch) clearInterval(this.loginWatch);
      this.loginWatch = null;
      if (!win.isDestroyed()) win.close();
      const hidden = await this.page();
      await hidden.loadURL(`${ORIGIN}/`).catch(() => {});
      this.onLoggedIn?.();
    }, 2000);
  }

  /**
   * Вход через обычный браузер: пользователь переносит cookie sessionKey, приложение кладёт её в свой профиль и проверяет
   * запросом к claude.ai. Значение нигде не логируется. LoginInputError (неверный ввод) пробрасывается вызывающему.
   */
  async importSessionKey(raw: string): Promise<{ ok: boolean; message: string; cloudflare?: boolean }> {
    const value = extractSessionKey(raw);
    await this.ses.cookies.set({
      url: ORIGIN,
      name: 'sessionKey',
      value,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_TTL_S,
    });
    await this.ses.cookies.flushStore();
    return this.verifyLogin({
      okLogMessage: 'вход выполнен через cookie из браузера',
      failMessage: (status) =>
        status === 401 || status === 403
          ? 'Claude не принял эту cookie: она устарела, скопирована не полностью или принадлежит другой сессии. Скопируйте её заново из браузера, где вы сейчас вошли.'
          : null,
      // Заведомо отвергнутую cookie не оставляем в профиле — нет смысла хранить то, что claude.ai не принял.
      onRejected: () => this.ses.cookies.remove(ORIGIN, 'sessionKey').catch(() => {}),
    });
  }

  /**
   * Запасной путь: тихо берёт сессию из хранилища установленного Claude Desktop (DPAPI) и проверяет её тем же
   * запросом к claude.ai. Ничего не читает из переписки — только cookie самого claude.ai.
   */
  async importFromDesktop(): Promise<{ ok: boolean; message: string; cloudflare?: boolean }> {
    const cookies = await importClaudeDesktopCookies(this.log);
    if (!cookies || cookies.length === 0) {
      return { ok: false, message: 'Claude Desktop не найден или не удалось прочитать его сессию. Если приложение открыто, выйдите и войдите там заново, затем повторите.' };
    }
    for (const c of cookies) {
      await this.ses.cookies
        .set({
          url: ORIGIN,
          name: c.name,
          value: c.value,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_TTL_S,
        })
        .catch(() => {});
    }
    return this.verifyLogin({
      okLogMessage: `сессия восстановлена из Claude Desktop (cookie: ${cookies.length})`,
      failMessage: (status) => (status === 401 || status === 403 ? 'Claude Desktop нашёлся, но его сессия не подошла: похоже, там тоже нужен вход заново.' : null),
    });
  }

  /** Общая проверка после установки cookie: запрос к claude.ai, закрепление сессии, разбор Cloudflare/401/403. */
  private async verifyLogin(opts: {
    okLogMessage: string;
    failMessage: (status: number) => string | null;
    onRejected?: () => Promise<void> | void;
  }): Promise<{ ok: boolean; message: string; cloudflare?: boolean }> {
    const win = await this.page();
    await win.loadURL(`${ORIGIN}/`).catch(() => {});
    const res = await this.fetchJson('/api/organizations');
    const challenge = !!res.text && /just a moment|cf-chl|challenge-platform/i.test(res.text);
    if (res.status === 200 && Array.isArray(res.json)) {
      await this.persistSessionCookies();
      this.log(opts.okLogMessage);
      this.onLoggedIn?.();
      return { ok: true, message: 'Готово: claude.ai принял сессию. Виджет начнёт показывать лимиты.' };
    }
    if (challenge) {
      // Cookie могла быть верной: Cloudflare просто просит проверку для нового профиля приложения.
      return { ok: false, cloudflare: true, message: 'Cloudflare просит проверку для этого окна. Откройте страницу claude.ai в приложении, пройдите проверку и повторите.' };
    }
    if (res.status === 401 || res.status === 403) await opts.onRejected?.();
    return { ok: false, message: opts.failMessage(res.status) ?? `claude.ai ответил неожиданно (код ${res.status}). Проверьте прокси и повторите.` };
  }

  /** Окно со страницей claude.ai без автозакрытия: чтобы пройти проверку Cloudflare или проверить, что вход виден приложению. */
  openPage(): void {
    const win = new BrowserWindow({
      width: 980,
      height: 760,
      title: 'claude.ai — окно приложения',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
    });
    this.configureWindow(win);
    void win.loadURL(`${ORIGIN}/`);
    win.on('closed', () => void this.page().then((w) => w.loadURL(`${ORIGIN}/`).catch(() => {})));
  }

  /** Подсказка для шага 0: что видно о cookie сессии (без значений). */
  async describeCookies(): Promise<Array<{ name: string; session: boolean; httpOnly: boolean; expiresInDays: number | null }>> {
    const cookies = await this.ses.cookies.get({ url: ORIGIN });
    const now = Date.now() / 1000;
    return cookies.map((c) => ({
      name: c.name,
      session: !!c.session,
      httpOnly: !!c.httpOnly,
      expiresInDays: c.expirationDate ? Math.round(((c.expirationDate - now) / 86400) * 10) / 10 : null,
    }));
  }
}
