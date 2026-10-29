/** 5.3: the settings IPC — the Serper key rows never reach a renderer; `settings:serper:*` routes to SerperKey. */
import {describe, it, expect, beforeEach, vi} from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }},
}));
vi.mock('@/main/logger', () => ({log: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

import {registerSettingsHandlers} from '@/main/ipc/settings';
import {SettingsService} from '@/main/settings-service';
import {SerperKey} from '@/main/serper-key';

let table: Map<string, string>;
let sent: unknown[];
const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

beforeEach(() => {
  handlers.clear();
  table = new Map([['themeMode', 'dark']]);
  sent  = [];
  const store = {
    get:    (k: string) => table.get(k),
    set:    (k: string, v: string) => { table.set(k, v); },
    delete: (k: string) => { table.delete(k); },
    getAll: () => Object.fromEntries(table),
  };
  registerSettingsHandlers(
    new SettingsService({
      store,
      broadcast: (_channel, payload) => { sent.push(payload); },
      tracking:  {reconfigure: () => undefined},
      log:       {reloadConfig: () => undefined, error: () => undefined},
    }),
    new SerperKey({
      crypto: {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async s => Buffer.from(`x${s}`),
        decryptStringAsync: async b => ({result: b.toString().slice(1), shouldReEncrypt: false}),
      },
      store,
      log: {info: () => undefined, warn: () => undefined},
    }),
  );
});

describe('settings IPC — the Serper key', () => {
  it('serper:set → has true; settings:get-all still never carries either row', async () => {
    expect(await call('settings:serper:has')).toBe(false);
    await call('settings:serper:set', 'secret-key');
    expect(await call('settings:serper:has')).toBe(true);
    table.set('serper_api_key', 'legacy-secret');
    expect(await call('settings:get-all')).toEqual({themeMode: 'dark'});
  });

  it('serper:set never broadcasts (the overlay never hears of the key)', async () => {
    await call('settings:serper:set', 'secret-key');
    await call('settings:serper:clear');
    expect(sent).toEqual([]);
  });

  it('serper:clear → has false', async () => {
    await call('settings:serper:set', 'secret-key');
    await call('settings:serper:clear');
    expect(await call('settings:serper:has')).toBe(false);
    expect(table.has('serper_api_key_enc')).toBe(false);
  });

  it.each(['serper_api_key', 'serper_api_key_enc'])('settings:set(%s) rejects and writes nothing', async key => {
    await expect(call('settings:set', key, 'x')).rejects.toThrow(/not writable/);
    expect(table.has(key)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('no handler returns the key value', async () => {
    await call('settings:serper:set', 'secret-key');
    for (const channel of ['settings:serper:has', 'settings:serper:clear', 'settings:get-all']) {
      expect(JSON.stringify(await call(channel)) ?? '').not.toContain('secret-key');
    }
  });
});
