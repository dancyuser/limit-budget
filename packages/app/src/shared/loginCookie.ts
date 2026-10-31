// Вход через обычный браузер: пользователь входит на claude.ai там (Google, почта, как обычно) и переносит в виджет
// только cookie сессии sessionKey. Значение никогда не попадает в журнал и в тексты ошибок.

export class LoginInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginInputError';
  }
}

/**
 * Достаёт значение sessionKey из того, что вставил пользователь. Понимает:
 *  - само значение (`sk-ant-sid01-…`);
 *  - `sessionKey=значение`;
 *  - заголовок `Cookie: a=b; sessionKey=значение; c=d` целиком;
 *  - строку, скопированную из таблицы cookie в DevTools (`sessionKey<таб>значение<таб>claude.ai…`).
 * Остальные cookie игнорируются: cf_clearance привязана к браузеру и адресу, поэтому приложение получает свою.
 */
export function extractSessionKey(input: string): string {
  let t = input.trim().replace(/^cookie:\s*/i, '');
  t = t.replace(/^["']+|["']+$/g, '');
  if (t === '') throw new LoginInputError('Поле пустое: вставьте значение cookie sessionKey.');

  let value: string | undefined;
  const pair = /(?:^|[;\s])sessionKey=([^;\s"']+)/.exec(t);
  const table = /^sessionKey\s+(\S+)/.exec(t);
  if (pair) value = pair[1];
  else if (table) value = table[1];
  else if (!/[\s;=]/.test(t)) value = t;
  else throw new LoginInputError('Не нашёл sessionKey в вставленном тексте. Нужна cookie с именем sessionKey.');

  if (value.toLowerCase() === 'sessionkey') throw new LoginInputError('Вставлено имя cookie, а нужно её значение.');
  if (value.length < 20) throw new LoginInputError('Значение слишком короткое: похоже, скопировано не полностью.');
  if (value.length > 4096) throw new LoginInputError('Значение слишком длинное для cookie sessionKey.');
  if (!/^[\x21-\x7e]+$/.test(value)) throw new LoginInputError('В значении есть недопустимые символы: скопируйте его ещё раз целиком.');
  return value;
}
