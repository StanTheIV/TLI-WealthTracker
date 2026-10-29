/**
 * `updater:download` failure: the log gets the full description (stack), the
 * renderer only the head line — and a thrown non-Error can't break either.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  check:    vi.fn(),
  download: vi.fn(),
  error:    vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {handle: (channel: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(channel, fn); }, on: () => undefined},
  app:     {getVersion: () => '1.0.0'},
}));
vi.mock('@/main/updater', () => ({
  checkForUpdate:         h.check,
  downloadUpdate:         h.download,
  launchInstallerAndQuit: () => undefined,
  fetchChangelog:         async () => null,
  isNewer:                () => false,
}));
vi.mock('@/main/db', () => ({settingsGet: () => undefined, settingsSet: () => undefined}));
vi.mock('@/main/logger', () => ({log: {error: h.error, warn: () => undefined, info: () => undefined, debug: () => undefined}}));

import {registerUpdaterHandlers} from '@/main/ipc/updater';

registerUpdaterHandlers(() => null);
const download = () => h.handlers.get('updater:download')!() as Promise<{success: boolean; error?: string}>;

beforeEach(() => {
  vi.clearAllMocks();
  h.check.mockResolvedValue({version: 'v2.0.0', changelog: '', downloadUrl: 'https://example.invalid/setup.exe'});
});

describe('updater:download failure', () => {
  it('an Error: the reply carries `Name: message`, the log the stack', async () => {
    h.download.mockRejectedValue(new Error('Download failed: 404'));
    expect(await download()).toEqual({success: false, error: 'Error: Download failed: 404'});
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error.mock.calls[0][0]).toBe('update');
    expect(h.error.mock.calls[0][1]).toMatch(/^Download failed: Error: Download failed: 404\n\s+at /);
  });

  it.each<[string, () => unknown, string]>([
    ['null-prototype object', () => Object.create(null), '[object Object]'],
    ['symbol',                () => Symbol('net'),        'Symbol(net)'],
  ])('a thrown %s still resolves with a printable reply', async (_n, make, text) => {
    h.download.mockImplementation(async () => { throw make(); });
    expect(await download()).toEqual({success: false, error: text});
    expect(h.error).toHaveBeenCalledWith('update', `Download failed: ${text}`);
  });
});
