// Многие сайты (в частности вход через Google) отказывают во встроенном браузере Electron-приложений,
// определяя его по токену `Electron/x.x.x` (и, если задано, имени приложения) в строке User-Agent.
// Функция убирает эти токены, оставляя обычную строку десктопного Chrome, — так окно входа ведёт себя
// как настоящий браузер и сайт не видит разницы.

/**
 * Пример исходной строки (Electron 45):
 * "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Electron/45.2.1 Safari/537.36"
 * В собранном приложении Electron ещё добавляет имя продукта: "... Electron/45.2.1 LimitBudget/0.1.0 Safari/537.36".
 * После обработки оба токена убраны: "...Chrome/156.0.8078.75 Safari/537.36" — как у обычного Chrome.
 *
 * `appName` — имя приложения (app.getName()), если известно; без него функция всё равно уберёт токен Electron.
 */
export function desktopUserAgent(ua: string, appName?: string): string {
  const parts = ua.split(' ');
  const keep = parts.filter((tok) => {
    if (/^Electron\//i.test(tok)) return false;
    if (appName && new RegExp(`^${escapeRegExp(appName)}/`, 'i').test(tok)) return false;
    return true;
  });
  return keep.join(' ').replace(/\s{2,}/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
