/** 5.3 adversarial: the Serper key and its ciphertext never leak; failure modes of get/set/migrate. */
import {describe, it, expect} from 'vitest';
import {SerperKey, SERPER_KEY_SETTING as ENC, LEGACY_SERPER_KEY_SETTING as LEGACY} from '@/main/serper-key';
import {SettingsService} from '@/main/settings-service';

const KEY = 'sk-live-ADVERSARIAL-0123456789';
const enc = (p: string) => Buffer.from(`enc:${[...p].reverse().join('')}`);
const dec = (b: Buffer) => {
  const s = b.toString();
  if (!s.startsWith('enc:')) throw new Error(`cannot decrypt ${s}`);
  return [...s.slice(4)].reverse().join('');
};
const cipherOf = (p: string) => enc(p).toString('base64');

interface Fault {available: boolean; encryptThrows: boolean; decryptThrows: boolean; availableThrows: boolean}

/** A crypto whose errors ECHO their input, and a log that records every level. */
function build(initial: Record<string, string> = {}) {
  const table = new Map(Object.entries(initial));
  const logs: string[] = [];
  const fault: Fault = {available: true, encryptThrows: false, decryptThrows: false, availableThrows: false};
  const store = {
    get: (k: string) => table.get(k), set: (k: string, v: string) => { table.set(k, v); },
    delete: (k: string) => { table.delete(k); }, getAll: () => Object.fromEntries(table),
  };
  const key = new SerperKey({
    crypto: {
      isAsyncEncryptionAvailable: async () => { if (fault.availableThrows) throw new Error('probe failed'); return fault.available; },
      encryptStringAsync: async p => { if (fault.encryptThrows) throw new Error(`DPAPI failed on "${p}"`); return enc(p); },
      decryptStringAsync: async b => {
        if (fault.decryptThrows) throw new Error(`bad blob ${b.toString()}`);
        return {result: dec(b), shouldReEncrypt: false};
      },
    },
    store,
    log: {info: (_f, m) => { logs.push(`info ${m}`); }, warn: (_f, m) => { logs.push(`warn ${m}`); }},
  });
  const sent: {channel: string; payload: unknown}[] = [];
  const settings = new SettingsService({
    store,
    broadcast: (channel: string, payload?: unknown) => { sent.push({channel, payload}); },
    tracking: {reconfigure: () => undefined},
    log: {reloadConfig: () => undefined, error: (_f: string, m: string) => { logs.push(`error ${m}`); }},
  } as unknown as ConstructorParameters<typeof SettingsService>[0]);
  return {key, table, logs, fault, settings, sent};
}

const noSecret = (text: string, plain = KEY) => {
  expect(text).not.toContain(plain);
  expect(text).not.toContain(cipherOf(plain));
  expect(text).not.toContain(enc(plain).toString());
};
const warns = (logs: string[]) => logs.filter(l => l.startsWith('warn')).length;

describe('leaks', () => {
  it('encryptString echoing the key: set throws a value-free error, logs nothing secret', async () => {
    const h = build();
    h.fault.encryptThrows = true;
    let err: Error | undefined;
    try { await h.key.set(KEY); } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    noSecret(err!.message);
    noSecret(h.logs.join('\n'));
    expect(h.table.size).toBe(0);
  });

  it('migration failure (encrypt echoes the plaintext): warning is value-free, plaintext row kept', async () => {
    const h = build({[LEGACY]: KEY});
    h.fault.encryptThrows = true;
    await h.key.migratePlaintext();
    noSecret(h.logs.join('\n'));
    expect(h.table.get(LEGACY)).toBe(KEY);
    expect(h.table.has(ENC)).toBe(false);
  });

  it('migration with isEncryptionAvailable throwing never crashes startup and keeps the plaintext', async () => {
    const h = build({[LEGACY]: KEY});
    h.fault.availableThrows = true;
    await expect(h.key.migratePlaintext()).resolves.toBeUndefined();
    expect(h.table.get(LEGACY)).toBe(KEY);
  });

  it('decrypt failure (error echoes the ciphertext): warning is value-free', async () => {
    const h = build();
    await h.key.set(KEY);
    h.fault.decryptThrows = true;
    await h.key.get();
    noSecret(h.logs.join('\n'));
  });

  it('every success path logs without key or ciphertext (set, get, migrate, clear)', async () => {
    const h = build({[LEGACY]: 'legacy-secret-value'});
    await h.key.migratePlaintext();
    await h.key.set(KEY);
    await h.key.get(); await h.key.has(); await h.key.clear();
    noSecret(h.logs.join('\n'));
    noSecret(h.logs.join('\n'), 'legacy-secret-value');
  });

  it('SettingsService.getAll never carries either row, even with both populated', async () => {
    const h = build({themeMode: 'dark'});
    await h.key.set(KEY);
    h.table.set(LEGACY, 'legacy-secret-value');
    noSecret(JSON.stringify(h.settings.getAll()));
    expect(h.settings.getAll()).toEqual({themeMode: 'dark'});
  });

  it('the settings:changed broadcast payload carries neither row', async () => {
    const h = build();
    await h.key.set(KEY);
    h.table.set(LEGACY, 'legacy-secret-value');
    h.settings.set('themeMode', 'light');
    expect(h.sent.length).toBeGreaterThan(0);
    for (const s of h.sent) {
      const text = JSON.stringify(s.payload) ?? '';
      noSecret(text);
      expect(text).not.toContain('legacy-secret-value');
    }
  });

  it.each([ENC, LEGACY])('settings:set(%s) is refused and the error does not echo the value', async k => {
    const h = build();
    let err: Error | undefined;
    try { h.settings.set(k, KEY); } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/not writable/);
    expect(err!.message).not.toContain(KEY);
    expect(h.table.size).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it.each([`${LEGACY} `, ` ${ENC}`, LEGACY.toUpperCase(), `${ENC}\n`])(
    'settings:set(%j) variant is a different inert row: never surfaces in get/has, never migrates',
    async k => {
      const h = build();
      h.settings.set(k, KEY);
      expect(await h.key.has()).toBe(false);
      expect(await h.key.get()).toBeNull();
      await h.key.migratePlaintext();
      expect(h.table.has(ENC)).toBe(false);
    },
  );
});

describe('migratePlaintext', () => {
  it('idempotent across restarts', async () => {
    const h = build({[LEGACY]: KEY});
    await h.key.migratePlaintext();
    const after = Object.fromEntries(h.table);
    await h.key.migratePlaintext();
    await h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual(after);
    expect(await h.key.get()).toBe(KEY);
  });

  it('unavailable on two starts (warned each, plaintext kept), available on the third: migrated', async () => {
    const h = build({[LEGACY]: KEY});
    h.fault.available = false;
    await h.key.migratePlaintext();
    await h.key.migratePlaintext();
    expect(warns(h.logs)).toBe(2);
    expect(h.table.get(LEGACY)).toBe(KEY);
    h.fault.available = true;
    await h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({[ENC]: cipherOf(KEY)});
  });

  it('whitespace-only plaintext is deleted even while encryption is unavailable', async () => {
    const h = build({[LEGACY]: ' \t\n '});
    h.fault.available = false;
    await h.key.migratePlaintext();
    expect(h.table.size).toBe(0);
    expect(h.logs).toEqual([]);
  });

  it('_enc plus plaintext: plaintext wins and is deleted (set() deletes legacy, so only a downgrade-written plaintext can coexist, and that is the newer write)', async () => {
    const h = build({[ENC]: cipherOf('old-enc-key'), [LEGACY]: KEY});
    await h.key.migratePlaintext();
    expect(await h.key.get()).toBe(KEY);
    expect(h.table.has(LEGACY)).toBe(false);
  });

  it('a failed migration with an existing _enc row leaves both rows untouched', async () => {
    const h = build({[ENC]: cipherOf('old'), [LEGACY]: KEY});
    h.fault.encryptThrows = true;
    await h.key.migratePlaintext();
    expect(h.table.get(ENC)).toBe(cipherOf('old'));
    expect(h.table.get(LEGACY)).toBe(KEY);
  });
});

describe('get / has', () => {
  it('corrupt base64 never throws; warned once', async () => {
    const h = build({[ENC]: '@@@@%%%%'});
    expect(await h.key.get()).toBeNull();
    h.table.set(ENC, cipherOf(KEY).slice(0, 3));
    expect(await h.key.has()).toBe(false);
    expect(warns(h.logs)).toBe(1);
  });

  it('decrypt throwing repeatedly warns once; a later set re-arms it', async () => {
    const h = build();
    await h.key.set(KEY);
    h.fault.decryptThrows = true;
    for (let i = 0; i < 5; i++) { await h.key.get(); await h.key.has(); }
    expect(warns(h.logs)).toBe(1);
    h.fault.decryptThrows = false;
    await h.key.set(KEY);
    expect(await h.key.get()).toBe(KEY);
    h.fault.decryptThrows = true;
    await h.key.get();
    expect(warns(h.logs)).toBe(2);
  });

  it('a failed set does not reset the warning flag or drop the old row', async () => {
    const h = build();
    await h.key.set(KEY);
    h.fault.decryptThrows = true;
    await h.key.get();
    h.fault.available = false;
    await expect(h.key.set('other')).rejects.toThrow('Secure storage is unavailable');
    await h.key.get();
    expect(warns(h.logs)).toBe(1);
    expect(h.table.get(ENC)).toBe(cipherOf(KEY));
  });
});

describe('set inputs', () => {
  it.each([[42], [{a: 1}], [null], [undefined], [['k']], [true]])('non-string %j throws and stores nothing', async v => {
    const h = build({[LEGACY]: 'keep'});
    await expect(h.key.set(v as unknown as string)).rejects.toThrow(/empty/);
    expect(Object.fromEntries(h.table)).toEqual({[LEGACY]: 'keep'});
  });

  it('a 1 MB key round-trips', async () => {
    const h = build();
    const big = 'k'.repeat(1_000_000);
    await h.key.set(big);
    expect(await h.key.get()).toBe(big);
  });

  it('inner whitespace preserved, outer (incl. NBSP) trimmed', async () => {
    const h = build();
    await h.key.set('  a b  ');
    expect(await h.key.get()).toBe('a b');
  });

  it('encryption unavailable: nothing is stored anywhere', async () => {
    const h = build();
    h.fault.available = false;
    await expect(h.key.set(KEY)).rejects.toThrow();
    expect(h.table.size).toBe(0);
  });
});
