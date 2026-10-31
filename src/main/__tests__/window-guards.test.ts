/** 5.2: lockDownWebContents — every page-initiated navigation prevented (except a reload of the current URL), every
 *  window.open denied, each logged. */
import {describe, it, expect, vi} from 'vitest';
import {lockDownWebContents, type GuardableWebContents} from '@/main/window-guards';

function setup(getURL: () => string = () => 'http://localhost:5173/') {
  let navigate: ((event: {url: string; preventDefault(): void}) => void) | undefined;
  let openHandler: ((details: {url: string}) => {action: 'deny'}) | undefined;
  const on = vi.fn((event: string, listener: typeof navigate) => {
    if (event === 'will-navigate') navigate = listener;
  });
  const wc: GuardableWebContents = {
    on,
    getURL,
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

  describe('a reload of the current URL (location.reload, Vite full-reload) is let through', () => {
    it.each<[string, string, string]>([
      ['dev main', 'http://localhost:5173/', 'http://localhost:5173/'],
      ['dev main, no trailing slash', 'http://localhost:5173', 'http://localhost:5173/'],
      ['dev overlay', 'http://localhost:5173/?window=overlay', 'http://localhost:5173/?window=overlay'],
      ['packaged overlay', 'file:///C:/app/dist/index.html?window=overlay', 'file:///C:/app/dist/index.html?window=overlay'],
      ['differing hash', 'http://localhost:5173/?window=overlay#a', 'http://localhost:5173/?window=overlay#b'],
      ['hash only on target', 'file:///C:/app/dist/index.html', 'file:///C:/app/dist/index.html#x'],
    ])('%s: current %j → %j is not prevented and not logged', (_n, current, target) => {
      const {navigateTo, warn} = setup(() => current);
      expect(navigateTo(target)).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it.each<[string, string, string]>([
    ['different path', 'http://localhost:5173/', 'http://localhost:5173/other'],
    ['different query', 'http://localhost:5173/', 'http://localhost:5173/?window=overlay'],
    ['query dropped', 'http://localhost:5173/?window=overlay', 'http://localhost:5173/'],
    ['different origin', 'http://localhost:5173/', 'http://localhost:5174/'],
    ['external origin', 'file:///C:/app/dist/index.html', 'https://example.com/'],
    ['different file', 'file:///C:/app/dist/index.html', 'file:///C:/Users/me/Desktop/dropped.png'],
    ['unparsable target', 'http://localhost:5173/', 'not a url'],
    ['empty target', 'http://localhost:5173/', ''],
    ['unparsable current URL', 'not a url', 'not a url'],
    ['empty current URL', '', ''],
  ])('%s: current %j → %j is prevented and logged', (_n, current, target) => {
    const {navigateTo, warn} = setup(() => current);
    expect(navigateTo(target)).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a getURL that throws blocks the navigation instead of throwing', () => {
    const {navigateTo, warn} = setup(() => { throw new Error('destroyed'); });
    let prevent: ReturnType<typeof vi.fn> | undefined;
    expect(() => { prevent = navigateTo('http://localhost:5173/'); }).not.toThrow();
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a non-string getURL result blocks the navigation', () => {
    const {navigateTo} = setup(() => undefined as unknown as string);
    expect(navigateTo('http://localhost:5173/')).toHaveBeenCalledTimes(1);
  });

  it('every navigation is prevented, not just the first', () => {
    const {navigateTo, warn} = setup();
    for (let i = 0; i < 5; i++) expect(navigateTo(`https://x/${i}`)).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(5);
  });
});
