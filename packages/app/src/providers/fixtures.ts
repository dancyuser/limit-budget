// Обезличенные образцы данных для контрактных тестов и демо-режима. Реальных идентификаторов, путей и текстов нет.

/** Образец ответа эндпоинта использования claude.ai (форма из сторонних проектов; подтверждается на шаге 0). */
export function claudeUsageFixture(now: number, u5h = 34, u7d = 41): unknown {
  return {
    five_hour: { utilization: u5h, resets_at: new Date(now + 2.5 * 3_600_000).toISOString() },
    seven_day: { utilization: u7d, resets_at: new Date(now + 4 * 86_400_000).toISOString() },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 12.5, resets_at: new Date(now + 4 * 86_400_000).toISOString() },
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  };
}

export const CLAUDE_ORGS_FIXTURE: unknown = [
  { uuid: '00000000-0000-4000-8000-000000000001', name: 'Personal', capabilities: ['chat'] },
];

/**
 * Образец rollout-лога Codex: строки JSONL с turn_context, началом и концом задач и rate_limits.
 * Времена привязаны к `now`, чтобы заглушка показывала правдоподобные данные в любой момент.
 */
export function codexRolloutFixture(now: number): string[] {
  const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString();
  // Сбросы привязаны к сетке, а не к «сейчас»: у настоящих логов resets_at между опросами не плывёт.
  const H5 = 5 * 3_600_000;
  const W = 7 * 86_400_000;
  const resets5 = Math.floor((Math.floor(now / H5) * H5 + H5) / 1000);
  const resets7 = Math.floor((Math.floor(now / W) * W + W) / 1000);
  const line = (o: unknown) => JSON.stringify(o);
  return [
    line({ timestamp: iso(-90), type: 'turn_context', payload: { model: 'gpt-5-codex', effort: 'medium' } }),
    line({ timestamp: iso(-89), type: 'event_msg', payload: { type: 'task_started' } }),
    line({
      timestamp: iso(-80),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 } },
        rate_limits: {
          plan_type: 'plus',
          primary: { used_percent: 18.0, window_minutes: 300, resets_at: resets5 },
          secondary: { used_percent: 27.0, window_minutes: 10080, resets_at: resets7 },
        },
      },
    }),
    line({ timestamp: iso(-75), type: 'event_msg', payload: { type: 'task_complete' } }),
    line({ timestamp: iso(-40), type: 'turn_context', payload: { model: 'gpt-5-codex', effort: 'high' } }),
    line({ timestamp: iso(-39), type: 'event_msg', payload: { type: 'task_started' } }),
    line({
      timestamp: iso(-20),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 9000, output_tokens: 2100, total_tokens: 11100 } },
        rate_limits: {
          plan_type: 'plus',
          primary: { used_percent: 31.0, window_minutes: 300, resets_at: resets5 },
          secondary: { used_percent: 29.0, window_minutes: 10080, resets_at: resets7 },
        },
      },
    }),
    line({ timestamp: iso(-18), type: 'event_msg', payload: { type: 'task_complete' } }),
    line({ timestamp: iso(-1), type: 'event_msg', payload: { type: 'agent_message', message: '[текст не сохраняется]' } }),
  ];
}
