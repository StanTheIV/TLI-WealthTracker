// Start then a quick Stop: a hide before the unsized window's notify-ready cancels its pending show.
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {BrowserWindow} from 'electron';

const h = vi.hoisted(() => ({on: new Map<string, (...args: unknown[]) => unknown>()}));
vi.mock('electron', () => ({
  ipcMain: {on: (c: string, fn: (...a: unknown[]) => unknown) => { h.on.set(c, fn); }},
}));
vi.mock('@/main/logger', () => ({log: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}}));

import {registerOverlayHandlers} from '@/main/ipc/overlay';

interface FakeWindow { show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> }

beforeEach(() => h.on.clear());

describe('ipc/overlay — hide cancels a pending show', () => {
  it('a hide before notify-ready keeps the overlay hidden; a later show still works', () => {
    let win: FakeWindow | null = null;
    registerOverlayHandlers(
      () => win as unknown as BrowserWindow | null,
      () => { win = {show: vi.fn(), hide: vi.fn()}; },
      {moveBy: vi.fn(), persist: vi.fn()},
    );
    const send = (c: string) => h.on.get(c)!({});

    send('overlay:show');
    send('overlay:hide');
    send('overlay:notify-ready');
    expect(win!.show).not.toHaveBeenCalled();

    send('overlay:show'); // now sized
    expect(win!.show).toHaveBeenCalledTimes(1);
  });
});
