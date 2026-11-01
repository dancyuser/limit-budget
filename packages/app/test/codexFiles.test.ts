import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatGptProvider } from '../src/providers/chatgpt.js';
import { CodexRolloutSource, defaultCodexDir } from '../src/providers/codexFiles.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-01T12:00:00Z');
const H = 3_600_000;

function tree(): { dir: string; file: (day: string, name: string, lines: string[], mtime: number) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  roots.push(dir);
  return {
    dir,
    file(day, name, lines, mtime) {
      const [y, m, d] = day.split('-');
      const folder = join(dir, y, m, d);
      mkdirSync(folder, { recursive: true });
      const path = join(folder, name);
      writeFileSync(path, lines.join('\n') + '\n');
      utimesSync(path, new Date(mtime), new Date(mtime));
      return path;
    },
  };
}

const line = (o: unknown) => JSON.stringify(o);
const limits = (ts: number, used5: number, used7: number, limitId = 'codex') =>
  line({
    timestamp: new Date(ts).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: limitId,
        plan_type: 'plus',
        primary: { used_percent: used5, window_minutes: 300, resets_at: (ts + 3 * H) / 1000 },
        secondary: { used_percent: used7, window_minutes: 10080, resets_at: (ts + 4 * 24 * H) / 1000 },
      },
    },
  });
const filler = (n: number) => Array.from({ length: n }, (_, i) => line({ timestamp: new Date(NOW).toISOString(), type: 'response_item', payload: { text: 'x'.repeat(200), i } }));
const task = (start: number, end: number, model: string, effort: string) => [
  line({ timestamp: new Date(start).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
  line({ timestamp: new Date(start).toISOString(), type: 'turn_context', payload: { model, effort } }),
  line({ timestamp: new Date(end).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
];

describe('чтение каталога сессий Codex', () => {
  it('каталог по умолчанию: CODEX_HOME или ~/.codex/sessions', () => {
    expect(defaultCodexDir({ CODEX_HOME: 'D:\\codex' } as NodeJS.ProcessEnv, 'C:\\Users\\x')).toBe(join('D:\\codex', 'sessions'));
    expect(defaultCodexDir({} as NodeJS.ProcessEnv, 'C:\\Users\\x')).toBe(join('C:\\Users\\x', '.codex', 'sessions'));
  });

  it('нет каталога: понятная ошибка, а не пустой результат', async () => {
    const src = new CodexRolloutSource({ dir: join(tmpdir(), 'codex-sessions-none-' + Date.now()) });
    await expect(src.readLines()).rejects.toThrow(/Каталог логов Codex не найден/);
  });

  it('большой файл читается с хвоста: свежие лимиты находятся, обрезанная первая строка отбрасывается', async () => {
    const t = tree();
    // ~1 МБ мусора, в самом конце запись с лимитами
    t.file('2026-11-01', 'rollout-2026-11-01T10-00-00-aaa.jsonl', [...filler(5000), limits(NOW - H, 42, 77)], NOW);
    const src = new CodexRolloutSource({ dir: t.dir, tailBytes: 64 * 1024 });
    const lines = await src.readLines();
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.length).toBeLessThan(500); // читался хвост, а не весь файл
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow(); // ни одной обрезанной строки
    const snaps = await new ChatGptProvider(src, { now: () => NOW }).poll();
    expect(snaps.find((s) => s.window === '5h')?.usedPct).toBe(42);
    expect(snaps.find((s) => s.window === '7d')?.usedPct).toBe(77);
  });

  it('берутся самые свежие файлы, мусор в каталоге игнорируется, порядок — от старых к новым', async () => {
    const t = tree();
    t.file('2026-10-28', 'rollout-old.jsonl', [limits(NOW - 70 * H, 1, 1)], NOW - 70 * H);
    t.file('2026-10-31', 'rollout-mid.jsonl', [limits(NOW - 20 * H, 2, 2)], NOW - 20 * H);
    t.file('2026-11-01', 'rollout-new.jsonl', [limits(NOW - H, 3, 3)], NOW - H);
    t.file('2026-11-01', 'notes.txt', ['не rollout'], NOW);
    mkdirSync(join(t.dir, 'cache'), { recursive: true });
    writeFileSync(join(t.dir, 'cache', 'rollout-hidden.jsonl'), limits(NOW, 99, 99) + '\n');
    const src = new CodexRolloutSource({ dir: t.dir, maxFiles: 2 });
    const files = await src.readFiles();
    expect(files).toHaveLength(2);
    expect(files[0][0]).toContain('"used_percent":2');
    expect(files[1][0]).toContain('"used_percent":3');
  });

  it('лимиты берутся из самого свежего по времени сеанса, даже если файл параллельного сеанса новее по mtime', async () => {
    const t = tree();
    // Сеанс A открыт давно, но писал недавно; сеанс B менялся позже, а последняя запись лимитов в нём старше
    t.file('2026-11-01', 'rollout-A.jsonl', [limits(NOW - 30 * 60_000, 60, 80)], NOW - 20 * 60_000);
    t.file('2026-11-01', 'rollout-B.jsonl', [limits(NOW - 2 * H, 10, 70), ...filler(3)], NOW - 5 * 60_000);
    const snaps = await new ChatGptProvider(new CodexRolloutSource({ dir: t.dir }), { now: () => NOW }).poll();
    expect(snaps.find((s) => s.window === '5h')?.usedPct).toBe(60);
  });

  it('файл дописывается: новые строки видны со следующего чтения, неизменённый файл берётся из кэша', async () => {
    const t = tree();
    const path = t.file('2026-11-01', 'rollout-live.jsonl', [limits(NOW - 2 * H, 10, 50)], NOW - 2 * H);
    const src = new CodexRolloutSource({ dir: t.dir });
    const p = new ChatGptProvider(src, { now: () => NOW });
    expect((await p.poll()).find((s) => s.window === '5h')?.usedPct).toBe(10);
    expect(await src.readLines()).toHaveLength(1);
    appendFileSync(path, limits(NOW - H, 30, 55) + '\n');
    utimesSync(path, new Date(NOW - H), new Date(NOW - H));
    expect((await p.poll()).find((s) => s.window === '5h')?.usedPct).toBe(30);
  });

  it('строки с CRLF и незавершённая последняя строка не ломают чтение', async () => {
    const t = tree();
    const path = t.file('2026-11-01', 'rollout-crlf.jsonl', [], NOW);
    writeFileSync(path, limits(NOW - H, 15, 40) + '\r\n' + '{"timestamp":"2026-11-01T11:5'); // Codex дописывает строку прямо сейчас
    const snaps = await new ChatGptProvider(new CodexRolloutSource({ dir: t.dir }), { now: () => NOW }).poll();
    expect(snaps.find((s) => s.window === '5h')?.usedPct).toBe(15);
  });

  it('задачи и модель разбираются по файлам: модель одного сеанса не переходит в другой', async () => {
    const t = tree();
    t.file('2026-11-01', 'rollout-1.jsonl', [...task(NOW - 5 * H, NOW - 4 * H, 'gpt-5-codex', 'high'), limits(NOW - 4 * H, 20, 30)], NOW - 4 * H);
    t.file('2026-11-01', 'rollout-2.jsonl', [
      // в хвосте второго файла turn_context нет: модель неизвестна, а не «gpt-5-codex» из первого
      line({ timestamp: new Date(NOW - 3 * H).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }),
      line({ timestamp: new Date(NOW - 2 * H).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } }),
    ], NOW - 2 * H);
    const tasks = await new ChatGptProvider(new CodexRolloutSource({ dir: t.dir }), { now: () => NOW }).tasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ model: 'gpt-5-codex', effort: 'high', surface: 'codex_local', source: 'rollout' });
    expect((tasks[0].end!.getTime() - tasks[0].start.getTime()) / H).toBe(1);
    expect(tasks[1].model).toBeUndefined();
  });
});
