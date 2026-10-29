/** Adversarial 5.1d/e: logger config garbage + rotation, logging:report listener, overlay show races. */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, truncateSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import type {BrowserWindow, WebContents} from 'electron';
import {DEFAULT_LOG_CONFIG} from '@/shared/logging';

const h = vi.hoisted(() => ({
  on:    new Map<string, (...a: unknown[]) => unknown>(),
  error: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on:     (c: string, fn: (...a: unknown[]) => unknown) => { h.on.set(c, fn); },
    handle: vi.fn(),
  },
}));

describe('logger adversarial', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tli-adv-log-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, {recursive: true, force: true}); });
  const fresh = async () => { vi.resetModules(); return import('@/main/logger'); };

  it.each(['{not json', 'null', '"str"', '[]', '42', '{"enabled":"yes","features":"all","types":{}}', ''])(
    'garbage logging.file %j -> defaults (file warn+error), no throw', async (raw) => {
      const {initLogger, log} = await fresh();
      const file = join(dir, 'g.log');
      expect(() => initLogger({logFile: file, settings: () => ({'logging.file': raw, 'logging.console': raw})})).not.toThrow();
      log.info('app', 'i'); log.warn('app', 'w'); log.error('app', 'e');
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('] i');
      expect(text).toContain('] w');
      expect(text).toContain('] e');
    });

  it('junk inside features/types arrays does not throw; nothing matches', async () => {
    const {initLogger, log} = await fresh();
    const file = join(dir, 'j.log');
    initLogger({logFile: file, settings: () => ({'logging.file': JSON.stringify({enabled: true, features: [1, null, {}], types: ['bogus']})})});
    expect(() => { log.error('app', 'x'); log.debug('engine', 'y'); }).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it('the shared default is never mutated by a stored config or by logging', async () => {
    const snapshot = JSON.parse(JSON.stringify(DEFAULT_LOG_CONFIG));
    const {initLogger, log} = await fresh();
    initLogger({logFile: join(dir, 'm.log'), settings: () => ({'logging.file': JSON.stringify({types: ['debug']})})});
    log.debug('app', 'd'); log.reloadConfig();
    expect(JSON.parse(JSON.stringify(DEFAULT_LOG_CONFIG))).toEqual(snapshot);
  });

  it('a reader that throws at init and works after: reloadConfig adopts the stored config', async () => {
    const {initLogger, log} = await fresh();
    const file = join(dir, 'r.log');
    let ready = false;
    initLogger({logFile: file, settings: () => {
      if (!ready) throw new Error('no such table: settings');
      return {'logging.file': JSON.stringify({enabled: true, features: ['app'], types: ['info']})};
    }});
    log.info('app', 'before'); log.warn('app', 'warn-before');
    ready = true; log.reloadConfig();
    log.info('app', 'after'); log.warn('app', 'warn-after');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('] before');
    expect(text).toContain('warn-before');
    expect(text).toContain('] after');
    expect(text).not.toContain('warn-after');
  });

  it('rotation happens at init only, not on reloadConfig', async () => {
    const file = join(dir, 'rot.log');
    writeFileSync(file, '');
    truncateSync(file, 10 * 1024 * 1024 + 1);
    const {initLogger, log} = await fresh();
    initLogger({logFile: file, settings: () => ({})});
    expect(existsSync(`${file}.1`)).toBe(true);
    rmSync(`${file}.1`);
    writeFileSync(file, '');
    truncateSync(file, 10 * 1024 * 1024 + 1);
    log.reloadConfig(); log.error('app', 'grow');
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it('settingsGetAll before adoptDb throws', async () => {
    vi.resetModules();
    const db = await import('@/main/db');
    expect(() => db.settingsGetAll()).toThrow();
  });
});

describe('logging:report listener adversarial', () => {
  beforeEach(() => { h.on.clear(); h.error.mockReset(); vi.resetModules(); });

  async function reg(windowName: (s: WebContents) => string, now: () => number) {
    vi.doMock('@/main/logger', () => ({getLogFilePath: () => '', log: {error: h.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn()}}));
    const {registerLoggingHandlers} = await import('@/main/ipc/logging');
    registerLoggingHandlers({windowName, now});
    return (id: number, ...args: unknown[]) => h.on.get('logging:report')!({sender: {id}}, ...args);
  }

  it('hostile fields are formatted and clipped; a throwing logger never escapes', async () => {
    const send = await reg(s => `w${s.id}`, () => 0);
    send(1, {a: 1}, undefined);
    send(1, 'x'.repeat(1e6), 'y'.repeat(1e6));
    expect(h.error.mock.calls[0][1]).toBe('w1 renderer error [[invalid tag]]: [invalid message]');
    expect(h.error.mock.calls[1][1].length).toBeLessThan(9_000);
    h.error.mockImplementation(() => { throw new Error('log down'); });
    expect(() => send(1, 't', 'm')).not.toThrow();
    expect(() => send(2)).not.toThrow();
  });

  it('two windows keep independent budgets; reset after exactly 60 000 ms', async () => {
    let t = 1000;
    const send = await reg(s => `w${s.id}`, () => t);
    for (let i = 0; i < 12; i++) send(1, 't', `m${i}`);
    expect(h.error).toHaveBeenCalledTimes(11);
    send(2, 't', 'other');
    expect(h.error).toHaveBeenCalledTimes(12);
    t += 59_999; send(1, 't', 'still dropped');
    expect(h.error).toHaveBeenCalledTimes(12);
    t += 1; send(1, 't', 'fresh');
    expect(h.error).toHaveBeenCalledTimes(13);
  });
});

describe('overlay show races', () => {
  beforeEach(() => { h.on.clear(); vi.resetModules(); });

  it('repeated shows while unsized create the window once and show once on notify-ready', async () => {
    vi.doMock('@/main/logger', () => ({log: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}}));
    const {registerOverlayHandlers} = await import('@/main/ipc/overlay');
    let win: {show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>} | null = null;
    const create = vi.fn(() => { win = {show: vi.fn(), hide: vi.fn()}; });
    registerOverlayHandlers(() => win as unknown as BrowserWindow | null, () => undefined, create, {moveBy: vi.fn(), persist: vi.fn()});
    const send = (c: string) => h.on.get(c)!({});
    for (let i = 0; i < 5; i++) send('overlay:show');
    expect(create).toHaveBeenCalledTimes(1);
    expect(win!.show).not.toHaveBeenCalled();
    send('overlay:notify-ready');
    send('overlay:notify-ready');
    expect(win!.show).toHaveBeenCalledTimes(1);
  });
});
