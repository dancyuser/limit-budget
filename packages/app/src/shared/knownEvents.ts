import { parseHm, zonedToMs } from '@limit-budget/core';
import type { Store } from './db.js';

/**
 * Известные изменения лимитов 2026 года: заносятся в журнал при первом запуске, чтобы детектор и пользователь
 * могли объяснять скачки. По сторонним обзорам; актуальность на 31 октября 2026 не перепроверялась.
 */
export const KNOWN_LIMIT_EVENTS: Array<{ date: string; text: string }> = [
  {
    date: '2026-05-13',
    text: 'Недельные лимиты платных планов выросли на 50%; по другому обзору повышение временное, до 13 июля, если не продлено (актуальность не проверена).',
  },
  {
    date: '2026-05-06',
    text: '5-часовые лимиты Claude Code удвоены, снижение в пиковые часы для Pro и Max убрано; для других поверхностей пиковые часы остаются на странице тарифа Pro.',
  },
  {
    date: '2026-03-26',
    text: 'В будни 5:00–11:00 PT (13:00–19:00 GMT) 5-часовые лимиты расходуются быстрее, недельные не менялись.',
  },
  { date: '2026-03-13', text: 'Две недели удвоенных лимитов вне пиковых часов, до 28 марта.' },
];

/** Заносит стартовые события один раз. Возвращает число добавленных пометок. */
export function seedKnownEvents(store: Store): number {
  if (store.getMeta('known-events-seeded')) return 0;
  for (const e of KNOWN_LIMIT_EVENTS) store.addNote(zonedToMs(e.date, parseHm('12:00'), 'UTC+3'), e.text, null);
  store.setMeta('known-events-seeded', '1');
  return KNOWN_LIMIT_EVENTS.length;
}
