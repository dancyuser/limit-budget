import { describe, expect, it } from 'vitest';
import { LoginInputError, extractSessionKey } from '../src/shared/loginCookie.js';

const KEY = 'sk-ant-sid01-AbCdEf0123456789_-AbCdEf0123456789AbCdEf0123456789';

describe('извлечение sessionKey из вставленного текста', () => {
  it('голое значение', () => {
    expect(extractSessionKey(KEY)).toBe(KEY);
    expect(extractSessionKey(`  ${KEY}\n`)).toBe(KEY);
    expect(extractSessionKey(`"${KEY}"`)).toBe(KEY);
  });

  it('пара имя=значение', () => {
    expect(extractSessionKey(`sessionKey=${KEY}`)).toBe(KEY);
    expect(extractSessionKey(`sessionKey=${KEY};`)).toBe(KEY);
  });

  it('заголовок Cookie целиком: берётся только sessionKey', () => {
    const header = `Cookie: lastActiveOrg=abc; sessionKey=${KEY}; cf_clearance=zzzzzzzzzzzzzzzzzzzzzzzz; __cf_bm=qqqq`;
    expect(extractSessionKey(header)).toBe(KEY);
    expect(extractSessionKey(`anthropic-device-id=1; sessionKey=${KEY}`)).toBe(KEY);
  });

  it('строка из таблицы cookie в DevTools (разделители — табы)', () => {
    expect(extractSessionKey(`sessionKey\t${KEY}\t.claude.ai\t/\t2026-12-01T00:00:00.000Z\t120\t✓`)).toBe(KEY);
  });

  it('понятные ошибки и никаких значений в тексте ошибки', () => {
    expect(() => extractSessionKey('')).toThrow(LoginInputError);
    expect(() => extractSessionKey('   ')).toThrow(/пустое/);
    expect(() => extractSessionKey('sessionKey')).toThrow(/имя cookie/);
    expect(() => extractSessionKey('abc')).toThrow(/короткое/);
    expect(() => extractSessionKey('a=b; c=d')).toThrow(/Не нашёл sessionKey/);
    expect(() => extractSessionKey('очень длинная строка без cookie внутри нее нет ничего')).toThrow(LoginInputError);
    expect(() => extractSessionKey('x'.repeat(5000))).toThrow(/длинное/);
    expect(() => extractSessionKey('кириллица-вместо-ключа-1234567890')).toThrow(/недопустимые/);
    let message = '';
    try {
      extractSessionKey(`sessionKey=${KEY.slice(0, 15)}`);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(KEY.slice(0, 15));
  });
});
