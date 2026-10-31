/**
 * 5.1d: engine:reset is an ipcMain.handle (a failed reset rejects the
 * renderer's invoke instead of reaching the process error handler), and
 * TrackingContext.reset awaits it and logs a refusal.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {registerEngineHandlers} from '@/main/ipc/engine';
import type {TrackingService} from '@/main/tracking-service';

const h = vi.hoisted(() => ({
  on:     new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on:     (c: string, fn: (...a: unknown[]) => unknown) => { h.on.set(c, fn); },
    handle: (c: string, fn: (...a: unknown[]) => unknown) => { h.handle.set(c, fn); },
  },
}));

beforeEach(() => {
  h.on.clear();
  h.handle.clear();
});

describe('ipc/engine — engine:reset', () => {
  it('is a handle (not an on) that calls tracking.reset and rejects on a throw', async () => {
    const reset = vi.fn();
    registerEngineHandlers({reset} as unknown as TrackingService);
    expect(h.on.has('engine:reset')).toBe(false);
    expect(h.handle.has('engine:reset')).toBe(true);
    await h.handle.get('engine:reset')!({});
    expect(reset).toHaveBeenCalledTimes(1);
    reset.mockImplementation(() => { throw new Error('reset failed'); });
    await expect((async () => h.handle.get('engine:reset')!({}))()).rejects.toThrow('reset failed');
  });
});

describe('TrackingContext.reset', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.unstubAllGlobals();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  async function setup(reset: () => Promise<void>) {
    const engine = {reset: vi.fn(reset)};
    vi.stubGlobal('window', {electronAPI: {engine, overlay: {show: vi.fn(), hide: vi.fn()}}});
    const {commands} = await import('@/state/TrackingContext');
    return {engine, commands};
  }

  it('awaits main\'s reset; success logs nothing', async () => {
    let resolve!: () => void;
    const {engine, commands} = await setup(() => new Promise<void>(r => { resolve = r; }));
    let done = false;
    const p = commands.reset().then(() => { done = true; });
    expect(engine.reset).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(done).toBe(false);
    resolve();
    await p;
    expect(done).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a rejected reset resolves (never rejects) and is logged', async () => {
    const err = new Error('reset failed');
    const {commands} = await setup(() => Promise.reject(err));
    await expect(commands.reset()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[session] reset failed:', err);
  });
});
