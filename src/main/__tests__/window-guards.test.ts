/** 5.2: lockDownWebContents — every page-initiated navigation prevented, every window.open denied, each logged. */
import {describe, it, expect, vi} from 'vitest';
import {lockDownWebContents, type GuardableWebContents} from '@/main/window-guards';

function setup() {
  let navigate: ((event: {url: string; preventDefault(): void}) => void) | undefined;
  let openHandler: ((details: {url: string}) => {action: 'deny'}) | undefined;
  const on = vi.fn((event: string, listener: typeof navigate) => {
    if (event === 'will-navigate') navigate = listener;
  });
  const wc: GuardableWebContents = {
    on,
    setWindowOpenHandler: (h) => { openHandler = h; },
  };
  const warn = vi.fn();
  lockDownWebContents(wc, 'main window', {warn});
  return {
    on, warn,
    navigateTo(url: unknown) {
      const preventDefault = vi.fn();
      navigate!({url: url as string, preventDefault});
      return preventDefault;
    },
    open: (details: unknown) => openHandler!(details as {url: string}),
  };
}

describe('lockDownWebContents', () => {
  it('registers exactly one will-navigate listener and a window-open handler', () => {
    const {on, open} = setup();
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0][0]).toBe('will-navigate');
    expect(open).toBeDefined();
  });

  it.each([
    'https://example.com/',
    'http://localhost:5173/?window=overlay',
    'file:///C:/Users/me/Desktop/dropped.png',
    'javascript:alert(1)',
    'not a url',
    '',
  ])('prevents navigation to %j and logs it with the window name', (url) => {
    const {navigateTo, warn} = setup();
    expect(navigateTo(url)).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('app');
    expect(warn.mock.calls[0][1]).toContain('main window');
    expect(warn.mock.calls[0][1]).toContain(url);
  });

  it('a long URL is clipped in the log line; navigation still prevented', () => {
    const {navigateTo, warn} = setup();
    const url = `https://example.com/${'a'.repeat(10_000)}`;
    expect(navigateTo(url)).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][1] as string;
    expect(line.length).toBeLessThan(400);
    expect(line).toContain('[truncated]');
  });

  it.each<[string, unknown]>([['undefined', undefined], ['null', null], ['number', 42], ['object', {}]])(
    'a %s URL still prevents navigation and never throws', (_n, url) => {
      const {navigateTo, warn} = setup();
      let prevent: ReturnType<typeof vi.fn> | undefined;
      expect(() => { prevent = navigateTo(url); }).not.toThrow();
      expect(prevent).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toContain('[no url]');
    });

  it.each(['https://example.com/', 'about:blank', '', 'file:///C:/x'])('window.open(%j) is denied and logged', (url) => {
    const {open, warn} = setup();
    expect(open({url})).toEqual({action: 'deny'});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toContain('window.open');
  });

  it.each<[string, unknown]>([['undefined details', undefined], ['null details', null], ['no url', {}], ['numeric url', {url: 7}]])(
    'window.open with %s is denied without throwing', (_n, details) => {
      const {open} = setup();
      expect(open(details)).toEqual({action: 'deny'});
    });

  it('every navigation is prevented, not just the first', () => {
    const {navigateTo, warn} = setup();
    for (let i = 0; i < 5; i++) expect(navigateTo(`https://x/${i}`)).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(5);
  });
});
