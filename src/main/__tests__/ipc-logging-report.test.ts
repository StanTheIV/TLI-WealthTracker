/** 5.1e: logging:report is an ipcMain.on that logs `app` errors naming the window, rate-limited per window. */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {WebContents} from 'electron';

const h = vi.hoisted(() => ({
  on:     new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>(),
  error:  vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on:     (c: string, fn: (...a: unknown[]) => unknown) => { h.on.set(c, fn); },
    handle: (c: string, fn: (...a: unknown[]) => unknown) => { h.handle.set(c, fn); },
  },
}));
vi.mock('@/main/logger', () => ({
  getLogFilePath: () => '/logs/app.log',
  log: {error: h.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn()},
}));

import {registerLoggingHandlers} from '@/main/ipc/logging';

const MAIN    = {id: 1};
const OVERLAY = {id: 2};

let t: number;
function register(windowName = (s: WebContents) => (s.id === 1 ? 'main window' : 'overlay')) {
  registerLoggingHandlers({windowName, now: () => t});
  return (sender: {id: number}, tag: unknown, message: unknown) => h.on.get('logging:report')!({sender}, tag, message);
}

beforeEach(() => {
  h.on.clear();
  h.handle.clear();
  h.error.mockReset();
  t = 0;
});

describe('ipc/logging — logging:report', () => {
  it('is an on (fire-and-forget) next to the get-log-path handle', () => {
    register();
    expect(h.on.has('logging:report')).toBe(true);
    expect(h.handle.has('logging:report')).toBe(false);
    expect(h.handle.get('logging:get-log-path')!()).toBe('/logs/app.log');
  });

  it('logs an app error naming the sender window', () => {
    const send = register();
    send(OVERLAY, 'render', 'Error: boom');
    expect(h.error).toHaveBeenCalledWith('app', 'overlay renderer error [render]: Error: boom');
  });

  it('10 per window per minute, then one suppressed line, then nothing; the other window is unaffected', () => {
    const send = register();
    for (let i = 0; i < 15; i++) send(MAIN, 'window error', `e${i}`);
    expect(h.error).toHaveBeenCalledTimes(11);
    expect(h.error.mock.calls[10][1]).toContain('main window: more than 10 renderer errors');
    send(OVERLAY, 'render', 'x');
    expect(h.error).toHaveBeenCalledTimes(12);
    t += 60_000;
    send(MAIN, 'window error', 'after the minute');
    expect(h.error).toHaveBeenLastCalledWith('app', 'main window renderer error [window error]: after the minute');
  });

  it('never throws out of the listener (a throwing window resolver)', () => {
    const send = register(() => { throw new Error('destroyed'); });
    expect(() => send(MAIN, 'render', 'x')).not.toThrow();
    expect(h.error).not.toHaveBeenCalled();
  });
});
