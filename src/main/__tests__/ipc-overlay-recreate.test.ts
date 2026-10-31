/**
 * 5.1e follow-up (b): a crash give-up destroys the overlay; the next
 * overlay:show recreates it and, a new unsized window, waits for its
 * renderer's notify-ready before showing.
 */
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

describe('ipc/overlay — show after the window was destroyed', () => {
  it('a recreated window shows only after its notify-ready', () => {
    let win: FakeWindow | null = null;
    const created: FakeWindow[] = [];
    registerOverlayHandlers(
      () => win as unknown as BrowserWindow | null,
      () => { win = {show: vi.fn(), hide: vi.fn()}; created.push(win); },
      {moveBy: vi.fn(), persist: vi.fn()},
    );
    const send = (c: string) => h.on.get(c)!({});

    send('overlay:show');
    expect(created).toHaveLength(1);
    expect(created[0].show).not.toHaveBeenCalled();
    send('overlay:notify-ready');
    expect(created[0].show).toHaveBeenCalledTimes(1);

    send('overlay:show'); // same window, already sized
    expect(created[0].show).toHaveBeenCalledTimes(2);

    win = null; // destroyed on a crash give-up; its 'closed' handler nulls it
    send('overlay:show');
    expect(created).toHaveLength(2);
    expect(created[1].show).not.toHaveBeenCalled();
    send('overlay:notify-ready');
    expect(created[1].show).toHaveBeenCalledTimes(1);
  });
});
