import { describe, expect, it } from 'vitest';
import { ProxyError, describeProxy, effectiveProxy, formToProxy, parseProxy, proxyFromLaunch, proxyToForm } from '../src/shared/proxy.js';

describe('разбор адреса прокси', () => {
  it('краткая запись порта — локальный socks5', () => {
    expect(parseProxy('10808')).toEqual({ mode: 'fixed', rules: 'socks5://127.0.0.1:10808', display: 'socks5://127.0.0.1:10808' });
  });

  it('полный адрес со схемой сохраняется как есть', () => {
    expect(parseProxy('socks5://127.0.0.1:10808')).toMatchObject({ mode: 'fixed', rules: 'socks5://127.0.0.1:10808' });
    expect(parseProxy('http://127.0.0.1:10809')).toMatchObject({ rules: 'http://127.0.0.1:10809' });
    expect(parseProxy('SOCKS5://Proxy.local:1080/')).toMatchObject({ rules: 'socks5://Proxy.local:1080' });
  });

  it('host:port без схемы — socks5', () => {
    expect(parseProxy('192.168.1.5:1080')).toMatchObject({ rules: 'socks5://192.168.1.5:1080' });
    expect(parseProxy('[::1]:1080')).toMatchObject({ rules: 'socks5://[::1]:1080' });
  });

  it('пусто и system — системные настройки; off/direct — без прокси', () => {
    expect(parseProxy('')).toEqual({ mode: 'system' });
    expect(parseProxy(null)).toEqual({ mode: 'system' });
    expect(parseProxy('System')).toEqual({ mode: 'system' });
    expect(parseProxy('off')).toEqual({ mode: 'direct' });
    expect(parseProxy('DIRECT')).toEqual({ mode: 'direct' });
  });

  it('понятные ошибки на неверный ввод', () => {
    expect(() => parseProxy('ftp://x:1')).toThrow(ProxyError);
    expect(() => parseProxy('socks5://user:pass@host:1080')).toThrow(/Логин/);
    expect(() => parseProxy('70000')).toThrow(/вне диапазона/);
    expect(() => parseProxy('hello')).toThrow(/Не разобрать/);
    expect(() => parseProxy('0')).toThrow(ProxyError);
  });

  it('описание для интерфейса', () => {
    expect(describeProxy(parseProxy('10808'))).toBe('socks5://127.0.0.1:10808');
    expect(describeProxy({ mode: 'direct' })).toBe('без прокси');
    expect(describeProxy({ mode: 'system' })).toBe('системный');
  });
});

describe('откуда берётся прокси', () => {
  it('ключ запуска в обеих формах', () => {
    expect(proxyFromLaunch(['electron', 'main.js', '--proxy', '10808'], {})).toEqual({ value: '10808', source: 'launch' });
    expect(proxyFromLaunch(['--proxy=socks5://127.0.0.1:10808'], {})).toEqual({ value: 'socks5://127.0.0.1:10808', source: 'launch' });
  });

  it('ключ без значения — ошибка, а не молчаливый обход', () => {
    expect(() => proxyFromLaunch(['--proxy'], {})).toThrow(ProxyError);
    expect(() => proxyFromLaunch(['--proxy', '--demo'], {})).toThrow(ProxyError);
  });

  it('переменная окружения работает, если ключа нет; пустая — игнорируется', () => {
    expect(proxyFromLaunch([], { LIMIT_BUDGET_PROXY: '10808' })).toEqual({ value: '10808', source: 'env' });
    expect(proxyFromLaunch([], { LIMIT_BUDGET_PROXY: '  ' })).toBeUndefined();
    expect(proxyFromLaunch(['--demo'], {})).toBeUndefined();
  });

  it('приоритет: ключ запуска → окружение → настройки', () => {
    const saved = 'socks5://127.0.0.1:1111';
    expect(effectiveProxy(['--proxy', '2222'], { LIMIT_BUDGET_PROXY: '3333' }, saved)).toMatchObject({ source: 'launch', proxy: { rules: 'socks5://127.0.0.1:2222' } });
    expect(effectiveProxy([], { LIMIT_BUDGET_PROXY: '3333' }, saved)).toMatchObject({ source: 'env', proxy: { rules: 'socks5://127.0.0.1:3333' } });
    expect(effectiveProxy([], {}, saved)).toMatchObject({ source: 'settings', proxy: { rules: saved } });
    expect(effectiveProxy([], {}, null)).toMatchObject({ source: 'settings', proxy: { mode: 'system' } });
  });

  it('--proxy off отключает прокси, даже если он сохранён в настройках', () => {
    expect(effectiveProxy(['--proxy', 'off'], {}, 'socks5://127.0.0.1:1111').proxy).toEqual({ mode: 'direct' });
  });
});

describe('поля формы прокси', () => {
  it('пользователь вводит только порт: socks5 на локальном адресе', () => {
    expect(formToProxy({ mode: 'custom', scheme: 'socks5', host: '127.0.0.1', port: '10808' })).toBe('socks5://127.0.0.1:10808');
    expect(formToProxy({ mode: 'custom', scheme: 'http', host: ' 127.0.0.1 ', port: ' 10809 ' })).toBe('http://127.0.0.1:10809');
  });

  it('системный режим — null, без прокси — off', () => {
    expect(formToProxy({ mode: 'system', scheme: 'socks5', host: '', port: '' })).toBeNull();
    expect(formToProxy({ mode: 'direct', scheme: 'socks5', host: '', port: '' })).toBe('off');
  });

  it('неверные поля — понятные ошибки', () => {
    expect(() => formToProxy({ mode: 'custom', scheme: 'socks5', host: '', port: '10808' })).toThrow(/адрес/);
    expect(() => formToProxy({ mode: 'custom', scheme: 'socks5', host: '127.0.0.1', port: 'abc' })).toThrow(/Порт/);
    expect(() => formToProxy({ mode: 'custom', scheme: 'socks5', host: '127.0.0.1', port: '' })).toThrow(/Порт/);
    expect(() => formToProxy({ mode: 'custom', scheme: 'socks5', host: '127.0.0.1', port: '99999' })).toThrow(/вне диапазона/);
    expect(() => formToProxy({ mode: 'custom', scheme: 'socks5', host: 'a b', port: '1' })).toThrow(/пробелов/);
    expect(() => formToProxy({ mode: 'custom', scheme: 'socks5', host: 'user@host', port: '1' })).toThrow(ProxyError);
  });

  it('сохранённая строка раскладывается обратно по полям', () => {
    expect(proxyToForm('socks5://127.0.0.1:10808')).toEqual({ mode: 'custom', scheme: 'socks5', host: '127.0.0.1', port: '10808' });
    expect(proxyToForm('10809')).toEqual({ mode: 'custom', scheme: 'socks5', host: '127.0.0.1', port: '10809' });
    expect(proxyToForm('http://proxy.local:8080')).toEqual({ mode: 'custom', scheme: 'http', host: 'proxy.local', port: '8080' });
    expect(proxyToForm(null).mode).toBe('system');
    expect(proxyToForm('off').mode).toBe('direct');
    expect(proxyToForm('мусор').mode).toBe('system');
  });

  it('туда и обратно: поле → строка → поле не меняется', () => {
    const f = { mode: 'custom' as const, scheme: 'http' as const, host: '192.168.0.2', port: '3128' };
    expect(proxyToForm(formToProxy(f))).toEqual(f);
  });
});
