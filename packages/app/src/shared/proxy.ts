// Прокси для сетевых запросов виджета (claude.ai и всё остальное, что делает Chromium внутри Electron).
// Задаётся ключом запуска `--proxy`, переменной окружения LIMIT_BUDGET_PROXY или полем в настройках.
// Приоритет: ключ запуска → переменная окружения → настройки.

export type ProxyMode =
  | { mode: 'system' } // как в Windows (поведение Electron по умолчанию)
  | { mode: 'direct' } // без прокси
  | { mode: 'fixed'; rules: string; display: string };

/** Значение по умолчанию для краткой записи `--proxy 10808`: локальный SOCKS5 (v2rayN, xray и т. п.). */
export const DEFAULT_PROXY_HOST = '127.0.0.1';

const SCHEMES = ['socks5', 'socks4', 'http', 'https'] as const;

export class ProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyError';
  }
}

/**
 * Разбор строки прокси.
 *  - пусто, `system`            → системные настройки Windows;
 *  - `off`, `direct`, `none`    → без прокси;
 *  - `10808`                    → socks5://127.0.0.1:10808;
 *  - `host:port`                → socks5://host:port (схема по умолчанию — socks5);
 *  - `socks5://host:port`, `http://host:port`, … → как есть.
 * Имя пользователя и пароль в адресе не поддерживаются: Chromium не принимает их в proxy-server.
 */
export function parseProxy(input: string | null | undefined): ProxyMode {
  const raw = (input ?? '').trim();
  if (raw === '' || /^system$/i.test(raw)) return { mode: 'system' };
  if (/^(off|direct|none)$/i.test(raw)) return { mode: 'direct' };

  let scheme = 'socks5';
  let rest = raw;
  const m = /^([a-z0-9]+):\/\/(.*)$/i.exec(raw);
  if (m) {
    scheme = m[1].toLowerCase();
    rest = m[2];
    if (!(SCHEMES as readonly string[]).includes(scheme)) {
      throw new ProxyError(`Схема «${scheme}» не поддерживается; допустимо: ${SCHEMES.join(', ')}`);
    }
  }
  rest = rest.replace(/\/+$/, '');
  if (rest.includes('@')) throw new ProxyError('Логин и пароль в адресе прокси не поддерживаются');
  if (/^\d+$/.test(rest)) rest = `${DEFAULT_PROXY_HOST}:${rest}`;
  const hp = /^(\[[0-9a-f:]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/i.exec(rest);
  if (!hp) throw new ProxyError(`Не разобрать адрес прокси «${raw}»: ожидается порт, host:port или схема://host:port`);
  const port = Number(hp[2]);
  if (port < 1 || port > 65535) throw new ProxyError(`Порт прокси вне диапазона: ${port}`);
  const rules = `${scheme}://${hp[1]}:${port}`;
  return { mode: 'fixed', rules, display: rules };
}

export function describeProxy(p: ProxyMode): string {
  return p.mode === 'fixed' ? p.rules : p.mode === 'direct' ? 'без прокси' : 'системный';
}

export type ProxySource = 'launch' | 'env' | 'settings';

/** Прокси из ключа запуска (`--proxy x` или `--proxy=x`) и переменной окружения; undefined — не задан. */
export function proxyFromLaunch(
  argv: string[],
  env: Record<string, string | undefined>,
): { value: string; source: 'launch' | 'env' } | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--proxy') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new ProxyError('После --proxy нужен адрес, например --proxy socks5://127.0.0.1:10808');
      return { value: v, source: 'launch' };
    }
    if (a.startsWith('--proxy=')) return { value: a.slice('--proxy='.length), source: 'launch' };
  }
  const e = env.LIMIT_BUDGET_PROXY;
  if (e !== undefined && e.trim() !== '') return { value: e, source: 'env' };
  return undefined;
}

/** Итоговый выбор: запуск и окружение важнее настроек. */
export function effectiveProxy(
  argv: string[],
  env: Record<string, string | undefined>,
  saved: string | null | undefined,
): { proxy: ProxyMode; source: ProxySource; raw: string } {
  const launch = proxyFromLaunch(argv, env);
  if (launch) return { proxy: parseProxy(launch.value), source: launch.source, raw: launch.value };
  return { proxy: parseProxy(saved), source: 'settings', raw: saved ?? '' };
}

// --- форма в настройках: режим, тип, адрес, порт ---------------------------------------------

export type ProxyFormMode = 'system' | 'custom' | 'direct';
export type ProxyScheme = 'socks5' | 'http' | 'socks4' | 'https';

export interface ProxyForm {
  mode: ProxyFormMode;
  scheme: ProxyScheme;
  host: string;
  port: string;
}

export const DEFAULT_PROXY_FORM: ProxyForm = { mode: 'system', scheme: 'socks5', host: DEFAULT_PROXY_HOST, port: '10808' };

/** Сохранённая строка → поля формы. Для системного режима поля «свой прокси» заполнены разумными значениями по умолчанию. */
export function proxyToForm(saved: string | null | undefined): ProxyForm {
  let p: ProxyMode;
  try {
    p = parseProxy(saved);
  } catch {
    return { ...DEFAULT_PROXY_FORM };
  }
  if (p.mode === 'system') return { ...DEFAULT_PROXY_FORM, mode: 'system' };
  if (p.mode === 'direct') return { ...DEFAULT_PROXY_FORM, mode: 'direct' };
  const m = /^([a-z0-9]+):\/\/(.+):(\d+)$/.exec(p.rules)!;
  return { mode: 'custom', scheme: m[1] as ProxyScheme, host: m[2], port: m[3] };
}

/** Поля формы → строка для настроек (null — системный прокси). Неверные поля дают ProxyError с понятным текстом. */
export function formToProxy(f: ProxyForm): string | null {
  if (f.mode === 'system') return null;
  if (f.mode === 'direct') return 'off';
  const host = f.host.trim();
  const port = f.port.trim();
  if (host === '') throw new ProxyError('Укажите адрес прокси, например 127.0.0.1');
  if (/\s/.test(host) || host.includes('/') || host.includes('@')) throw new ProxyError('В адресе прокси не должно быть пробелов, «/» и «@»');
  if (!/^\d+$/.test(port)) throw new ProxyError('Порт — это число от 1 до 65535, например 10808');
  const value = `${f.scheme}://${host}:${port}`;
  parseProxy(value); // проверяет диапазон порта и допустимость адреса
  return value;
}
