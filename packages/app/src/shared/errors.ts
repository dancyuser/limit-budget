/** Провайдер не вошёл в аккаунт: виджет показывает «нужен вход», а не ложные нули. */
export class AuthRequiredError extends Error {
  constructor(message = 'Требуется вход в аккаунт') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** Нет связи с источником (сеть, прокси): виджет подсказывает проверить настройки прокси. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Источник вернул ответ, форма которого не совпала с ожидаемой: адаптер надо поправить после шага 0. */
export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}
