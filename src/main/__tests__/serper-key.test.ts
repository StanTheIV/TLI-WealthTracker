/** 5.3: SerperKey over a fake safeStorage and a Map-backed settings table — no electron. */
import {describe, it, expect} from 'vitest';
import {SerperKey, SERPER_KEY_SETTING, LEGACY_SERPER_KEY_SETTING} from '@/main/serper-key';

const ENC    = SERPER_KEY_SETTING;
const LEGACY = LEGACY_SERPER_KEY_SETTING;
const KEY    = 'sk-live-0123456789';

/** Reversible, visibly not-plaintext "encryption". */
const fakeEncrypt = (plain: string) => Buffer.from(`enc:${[...plain].reverse().join('')}`);

/** The fake safeStorage, each failure mode switchable. */
function build(initial: Record<string, string> = {}) {
  const table = new Map(Object.entries(initial));
  const logs: {type: 'info' | 'warn'; message: string}[] = [];
  const fault = {available: true, encryptThrows: false, decryptThrows: false};
  const crypto = {
    isEncryptionAvailable: () => fault.available,
    encryptString: (plain: string) => {
      if (fault.encryptThrows) throw new Error('DPAPI failed');
      return fakeEncrypt(plain);
    },
    decryptString: (buf: Buffer) => {
      const s = buf.toString();
      if (fault.decryptThrows || !s.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext');
      return [...s.slice(4)].reverse().join('');
    },
  };
  const key = new SerperKey({
    crypto,
    store: {
      get:    k => table.get(k),
      set:    (k, v) => { table.set(k, v); },
      delete: k => { table.delete(k); },
    },
    log: {
      info: (_f, message) => { logs.push({type: 'info', message}); },
      warn: (_f, message) => { logs.push({type: 'warn', message}); },
    },
  });
  const ciphertext = (plain: string) => fakeEncrypt(plain).toString('base64');
  return {key, table, logs, fault, ciphertext};
}

/** Neither the key nor its ciphertext appears in any log line. */
function expectNoSecretLogged(h: ReturnType<typeof build>, plain = KEY): void {
  const all = h.logs.map(l => l.message).join('\n');
  expect(all).not.toContain(plain);
  expect(all).not.toContain(h.ciphertext(plain));
}

describe('SerperKey — has / get / set / clear', () => {
  it('nothing stored: has false, get null', () => {
    const h = build();
    expect(h.key.has()).toBe(false);
    expect(h.key.get()).toBeNull();
  });

  it('set stores base64 ciphertext under the _enc row (never the plaintext); get round-trips', () => {
    const h = build();
    h.key.set(KEY);
    expect([...h.table.keys()]).toEqual([ENC]);
    expect(h.table.get(ENC)).toBe(h.ciphertext(KEY));
    expect(h.table.get(ENC)).not.toContain(KEY);
    expect(h.key.has()).toBe(true);
    expect(h.key.get()).toBe(KEY);
    expectNoSecretLogged(h);
  });

  it('set trims the key', () => {
    const h = build();
    h.key.set(`  ${KEY}\n`);
    expect(h.key.get()).toBe(KEY);
  });

  it.each(['', '   ', '\t\n'])('set(%j) throws and stores nothing', blank => {
    const h = build();
    expect(() => h.key.set(blank)).toThrow(/empty/);
    expect(h.table.size).toBe(0);
  });

  it('a non-string from IPC throws like an empty key', () => {
    const h = build();
    expect(() => h.key.set(42 as unknown as string)).toThrow(/empty/);
    expect(h.table.size).toBe(0);
  });

  it('encryption unavailable: set throws a clear error and stores nothing (no plaintext fallback)', () => {
    const h = build({[ENC]: 'previous'});
    h.fault.available = false;
    expect(() => h.key.set(KEY)).toThrow('Secure storage is unavailable');
    expect(Object.fromEntries(h.table)).toEqual({[ENC]: 'previous'});
  });

  it('encryptString throwing: set throws a value-free error and stores nothing', () => {
    const h = build();
    h.fault.encryptThrows = true;
    let err: unknown;
    try { h.key.set(KEY); } catch (e) { err = e; }
    expect((err as Error).message).toBe('Encrypting the Serper API key failed');
    expect((err as Error).message).not.toContain(KEY);
    expect(h.table.size).toBe(0);
  });

  it('set replaces an earlier key and supersedes a legacy plaintext row', () => {
    const h = build({[LEGACY]: 'old-plain'});
    h.key.set('first');
    h.key.set(KEY);
    expect(h.key.get()).toBe(KEY);
    expect(h.table.has(LEGACY)).toBe(false);
  });

  it('clear deletes the _enc row and any legacy plaintext row, and keeps other settings', () => {
    const h = build({[LEGACY]: 'old-plain', themeMode: 'dark'});
    h.key.set(KEY);
    h.table.set(LEGACY, 'old-plain');
    h.key.clear();
    expect(Object.fromEntries(h.table)).toEqual({themeMode: 'dark'});
    expect(h.key.has()).toBe(false);
  });
});

describe('SerperKey — a stored key that does not decrypt', () => {
  it('decryptString throwing (another user / machine): get null, has false, warned once without the value', () => {
    const h = build();
    h.key.set(KEY);
    h.fault.decryptThrows = true;
    expect(h.key.get()).toBeNull();
    expect(h.key.has()).toBe(false);
    expect(h.key.get()).toBeNull();
    expect(h.logs.filter(l => l.type === 'warn')).toHaveLength(1);
    expectNoSecretLogged(h);
    expect(h.table.has(ENC)).toBe(true);   // left for the user to replace, not silently dropped
  });

  it('garbage in the _enc row: get null', () => {
    const h = build({[ENC]: 'not-base64-ciphertext!!'});
    expect(h.key.get()).toBeNull();
    expect(h.key.has()).toBe(false);
  });

  it('a row that decrypts to an empty string: get null, has false', () => {
    const h = build();
    h.table.set(ENC, h.ciphertext(''));
    expect(h.key.get()).toBeNull();
    expect(h.key.has()).toBe(false);
  });

  it('an empty _enc row: get null without calling decrypt', () => {
    const h = build({[ENC]: ''});
    h.fault.decryptThrows = true;
    expect(h.key.get()).toBeNull();
    expect(h.logs).toEqual([]);
  });

  it('a successful set re-arms the one-time decrypt warning', () => {
    const h = build();
    h.key.set(KEY);
    h.fault.decryptThrows = true;
    h.key.get();
    h.fault.decryptThrows = false;
    h.key.set(KEY);
    h.fault.decryptThrows = true;
    h.key.get();
    expect(h.logs.filter(l => l.type === 'warn')).toHaveLength(2);
  });
});

describe('SerperKey.migratePlaintext', () => {
  it('a plaintext key is encrypted into _enc and the plaintext row DELETED', () => {
    const h = build({[LEGACY]: KEY, themeMode: 'dark'});
    h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({themeMode: 'dark', [ENC]: h.ciphertext(KEY)});
    expect(h.key.get()).toBe(KEY);
    expectNoSecretLogged(h);
  });

  it('the plaintext is trimmed on the way', () => {
    const h = build({[LEGACY]: ` ${KEY} `});
    h.key.migratePlaintext();
    expect(h.key.get()).toBe(KEY);
  });

  it('is idempotent: a second run changes nothing and logs nothing', () => {
    const h = build({[LEGACY]: KEY});
    h.key.migratePlaintext();
    const after = Object.fromEntries(h.table);
    const logged = h.logs.length;
    h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual(after);
    expect(h.logs).toHaveLength(logged);
  });

  it('no plaintext row: a no-op that leaves an existing _enc row alone', () => {
    const h = build();
    h.key.set(KEY);
    const before = Object.fromEntries(h.table);
    h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual(before);
  });

  it.each(['', '  '])('an empty plaintext row (%j) is just deleted — no _enc row', blank => {
    const h = build({[LEGACY]: blank});
    h.fault.available = false;   // not even needed
    h.key.migratePlaintext();
    expect(h.table.size).toBe(0);
  });

  it('encryption unavailable: the plaintext row stays, warned without the value; a later run migrates it', () => {
    const h = build({[LEGACY]: KEY});
    h.fault.available = false;
    h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({[LEGACY]: KEY});
    expect(h.logs.map(l => l.type)).toEqual(['warn']);
    expectNoSecretLogged(h);

    h.fault.available = true;
    h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({[ENC]: h.ciphertext(KEY)});
  });

  it('encryptString throwing: the plaintext row stays, warned without the value, nothing half-written', () => {
    const h = build({[LEGACY]: KEY});
    h.fault.encryptThrows = true;
    expect(() => h.key.migratePlaintext()).not.toThrow();
    expect(Object.fromEntries(h.table)).toEqual({[LEGACY]: KEY});
    expect(h.logs.map(l => l.type)).toEqual(['warn']);
    expectNoSecretLogged(h);
  });

  it('both rows present (an interrupted earlier run): the plaintext wins once and is deleted', () => {
    const h = build({[LEGACY]: KEY, [ENC]: 'stale'});
    h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({[ENC]: h.ciphertext(KEY)});
  });
});
