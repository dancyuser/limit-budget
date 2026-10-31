import { describe, expect, it } from 'vitest';
import { desktopUserAgent } from '../src/shared/userAgent.js';

describe('desktopUserAgent: строка как у обычного Chrome', () => {
  it('убирает Electron/x.x.x (реальная строка Electron 45)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Electron/45.2.1 Safari/537.36';
    expect(desktopUserAgent(ua)).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Safari/537.36');
  });

  it('убирает и имя приложения, которое Electron дописывает после Electron/x.x.x', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Electron/45.2.1 LimitBudget/0.1.0 Safari/537.36';
    expect(desktopUserAgent(ua, 'LimitBudget')).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Safari/537.36');
  });

  it('результат не содержит токенов Electron или имени приложения', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/156.0.0.0 Electron/45.2.1 LimitBudget/0.1.0 Safari/537.36';
    const out = desktopUserAgent(ua, 'LimitBudget');
    expect(out).not.toMatch(/Electron/i);
    expect(out).not.toMatch(/LimitBudget/i);
    expect(out).toMatch(/^Mozilla\/5\.0/);
    expect(out).toMatch(/Chrome\/156\.0\.0\.0 Safari\/537\.36$/);
  });

  it('уже обычная строка Chrome не меняется', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    expect(desktopUserAgent(ua, 'LimitBudget')).toBe(ua);
  });

  it('без указания имени приложения убирает только Electron/x.x.x', () => {
    const ua = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0 Electron/45.2.1 SomeOtherApp/1.0 Safari/537.36';
    expect(desktopUserAgent(ua)).toBe('Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0 SomeOtherApp/1.0 Safari/537.36');
  });

  it('идемпотентна: повторный вызов ничего не меняет', () => {
    const ua = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0 Electron/45.2.1 LimitBudget/0.1.0 Safari/537.36';
    const once = desktopUserAgent(ua, 'LimitBudget');
    expect(desktopUserAgent(once, 'LimitBudget')).toBe(once);
  });
});
