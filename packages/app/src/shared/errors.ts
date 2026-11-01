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

/** Источник не ответил за отведённое время: чаще всего связь только поднимается (пробуждение, смена сети). */
export class PollTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PollTimeoutError';
  }
}

/** Временный сбой связи: опрос стоит повторить скоро, не дожидаясь обычного интервала. */
export function isTransientError(e: unknown): boolean {
  return e instanceof NetworkError || e instanceof PollTimeoutError;
}

/** Источник вернул ответ, форма которого не совпала с ожидаемой: адаптер надо поправить после шага 0. */
export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}
