import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli/index.js';
import { decryptChromiumCookie, readProtectedKey } from '../src/main/desktopSession.js';
import { gaugePng } from '../src/main/icon.js';
import { breakdownRows, redact } from '../src/main/spike.js';
import { Store } from '../src/shared/db.js';
import { KNOWN_LIMIT_EVENTS, seedKnownEvents } from '../src/shared/knownEvents.js';
import { defaultSettings, loadSettings, mergeSettings } from '../src/shared/settings.js';
import { toCsv } from '../src/shared/export.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('настройки', () => {
  it('слияние глубокое: частичное обновление не затирает остальные поля', () => {
    const merged = mergeSettings(defaultSettings(), { sounds: { volume: 0.2 }, widget: { bounds: { x: 1, y: 2 } } });
    expect(merged.sounds.volume).toBe(0.2);
    expect(merged.sounds.muted).toBe(false);
    expect(merged.sounds.perKind['limit-exceeded'].sound).toBe('exceeded');
    expect(merged.widget.bounds).toEqual({ x: 1, y: 2 });
    expect(merged.widget.opacity).toBe(0.96);
  });

  it('устаревшие настройки без новых сигналов достраиваются значениями по умолчанию', () => {
    const old = { signals: { enabled: { 'over-trajectory': false } }, sounds: { volume: 7 } };
    const s = loadSettings(old);
    expect(s.signals.enabled['over-trajectory']).toBe(false);
    expect(s.signals.enabled['limits-changed']).toBe(true);
    expect(s.sounds.perKind['peak-start'].sound).toBe('tick');
    expect(s.sounds.volume).toBe(1);
  });

  it('предупреждение и превышение лимита звучат разными сигналами', () => {
    const s = defaultSettings().sounds.perKind;
    expect(s['over-trajectory'].sound).not.toBe(s['limit-exceeded'].sound);
  });

  it('по умолчанию Claude включён, Codex выключен, запасной вход через Claude Desktop выключен', () => {
    const s = defaultSettings();
    expect(s.providers.claude.enabled).toBe(true);
    expect(s.providers.chatgpt.enabled).toBe(false);
    expect(s.desktopSessionFallback).toBe(false);
    expect(s.reserve).toBe(0.1);
  });
});

describe('запасной путь входа: криптография Chromium на синтетических данных', () => {
  it('расшифровывает v10-значение AES-256-GCM', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const enc = Buffer.concat([c.update('значение-cookie', 'utf8'), c.final()]);
    const blob = Buffer.concat([Buffer.from('v10'), nonce, enc, c.getAuthTag()]);
    expect(decryptChromiumCookie(blob, key)).toBe('значение-cookie');
  });

  it('отказывается от неизвестного формата и от испорченных данных', () => {
    const key = randomBytes(32);
    expect(() => decryptChromiumCookie(Buffer.from('v20' + 'x'.repeat(40)), key)).toThrow(/v20/);
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    const enc = Buffer.concat([c.update('abc'), c.final()]);
    const blob = Buffer.concat([Buffer.from('v10'), nonce, enc, c.getAuthTag()]);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptChromiumCookie(blob, key)).toThrow();
  });

  it('достаёт защищённый ключ из Local State', () => {
    const body = Buffer.from('protected-bytes');
    const ls = JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), body]).toString('base64') } });
    expect(readProtectedKey(ls).toString()).toBe('protected-bytes');
    expect(() => readProtectedKey('{}')).toThrow();
    expect(() => readProtectedKey(JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('nope').toString('base64') } }))).toThrow(/DPAPI/);
  });
});

describe('спайк: обезличивание образцов', () => {
  it('прячет идентификаторы, почты и свободный текст, оставляет числа и метки времени', () => {
    const out = redact({
      uuid: '7f1c2e9a-1b2c-4d3e-8f90-123456789abc',
      name: 'Иван Петров',
      email: 'someone@example.com',
      capabilities: ['chat', 'claude_pro'],
      five_hour: { utilization: 34, resets_at: '2026-11-03T12:00:00.000Z' },
      note: 'какой-то длинный свободный текст разговора',
    }) as Record<string, unknown>;
    expect(out.uuid).toBe('<uuid>');
    expect(out.name).toBe('<redacted>');
    expect(out.email).toBe('<redacted>');
    expect(out.capabilities).toEqual(['chat', 'claude_pro']);
    expect(out.five_hour).toEqual({ utilization: 34, resets_at: '2026-11-03T12:00:00.000Z' });
    expect(out.note).toBe('<str>');
  });
});

describe('спайк: разбивка недели', () => {
  it('оставляет подписи строк и доли, прячет почты и идентификаторы, пропускает мусор', () => {
    const rows = breakdownRows({
      seven_day_breakdown: {
        rows: [
          { key: 'a', display_name: 'Sonnet', percent: 31 },
          { key: 'b', display_name: 'Claude Code', percent: 57 },
          { key: 'c', display_name: 'me@example.com', percent: 12 },
          { key: 'd', display_name: '', percent: 0 },
          { key: 'e', display_name: 'нет доли' },
          null,
        ],
      },
    });
    expect(rows).toEqual([
      { label: 'Sonnet', percent: 31 },
      { label: 'Claude Code', percent: 57 },
      { label: '<email>', percent: 12 },
    ]);
    expect(breakdownRows({})).toEqual([]);
    expect(breakdownRows(null)).toEqual([]);
  });
});

describe('стартовые события и иконка', () => {
  it('известные изменения лимитов заносятся один раз', () => {
    const s = new Store(':memory:');
    expect(seedKnownEvents(s)).toBe(KNOWN_LIMIT_EVENTS.length);
    expect(seedKnownEvents(s)).toBe(0);
    expect(s.listNotes()).toHaveLength(KNOWN_LIMIT_EVENTS.length);
    s.close();
  });

  it('иконка трея — корректный PNG', () => {
    const png = gaugePng(32, 0.4, [78, 200, 130]);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.length).toBeGreaterThan(100);
  });

  it('CSV экранирует кавычки и разделители', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'He said "hi"'], [null, 1.23456]])).toBe('a,b\r\n"x,y","He said ""hi"""\r\n,1.235\r\n');
  });
});

describe('командная строка', () => {
  const run = async (db: string, ...argv: string[]) => {
    const lines: string[] = [];
    const code = await main([...argv, '--db', db], (s) => lines.push(s));
    return { code, text: lines.join('\n') };
  };

  it('seed-demo → status → stats → export → replay → gaps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lb-cli-'));
    dirs.push(dir);
    const db = join(dir, 'usage.sqlite');
    const seeded = await run(db, 'seed-demo', '--days', '10');
    expect(seeded.code).toBe(0);
    expect(seeded.text).toMatch(/Добавлено \d+ снимков/);

    const status = await run(db, 'status', '--json');
    const view = JSON.parse(status.text);
    expect(view.providers[0].id).toBe('claude');
    expect(view.providers[0].tick.u7d).toBeGreaterThanOrEqual(0);
    expect(view.providers[0].budget.target).not.toBeUndefined();

    const stats = await run(db, 'stats', '--period', 'week', '--json');
    expect(JSON.parse(stats.text).totals.gain7d).toBeGreaterThan(0);

    const csv = await run(db, 'export', '--what', 'days', '--period', 'week');
    expect(csv.text.split('\n')[0].trim()).toBe('date,gain_5h,gain_7d,work_hours,growth_minutes,vacation,deviation_end');

    const rep = await run(db, 'replay', '--json');
    expect(JSON.parse(rep.text).length).toBeGreaterThan(1000);

    // демо-история закончилась «сейчас», но внутри неё есть пропуск только на старте — критерий видит его
    const gaps = await run(db, 'gaps', '--days', '3', '--json');
    expect(JSON.parse(gaps.text).snapshots).toBeGreaterThan(4000);
    expect((await run(db, 'nope')).code).toBe(2);
    expect((await run(db)).code).toBe(1);
  }, 120_000);
});
