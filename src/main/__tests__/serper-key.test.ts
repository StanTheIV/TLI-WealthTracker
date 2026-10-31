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
  const fault = {
    available: true, encryptThrows: false, decryptThrows: false,
    /** The NEXT encryptStringAsync call (only) waits for it — an in-flight DPAPI call. */
    encryptGate: null as Promise<void> | null,
    /** The NEXT decryptStringAsync call (only) waits for it. */
    decryptGate: null as Promise<void> | null,
  };
  const crypto = {
    isAsyncEncryptionAvailable: async () => fault.available,
    encryptStringAsync: async (plain: string) => {
      const held = fault.encryptGate;
      fault.encryptGate = null;
      if (held) await held;
      if (fault.encryptThrows) throw new Error('DPAPI failed');
      return fakeEncrypt(plain);
    },
    decryptStringAsync: async (buf: Buffer) => {
      const held = fault.decryptGate;
      fault.decryptGate = null;
      if (held) await held;
      const s = buf.toString();
      // `old:` = sealed with a rotated-out key: still decrypts, flagged for re-encryption.
      const rotated = s.startsWith('old:');
      if (fault.decryptThrows || !(s.startsWith('enc:') || rotated)) throw new Error('Error while decrypting the ciphertext');
      return {result: [...s.slice(4)].reverse().join(''), shouldReEncrypt: rotated};
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
  it('nothing stored: has false, get null', async () => {
    const h = build();
    expect(await h.key.has()).toBe(false);
    expect(await h.key.get()).toBeNull();
  });

  it('set stores base64 ciphertext under the _enc row (never the plaintext); get round-trips', async () => {
    const h = build();
    await h.key.set(KEY);
    expect([...h.table.keys()]).toEqual([ENC]);
    expect(h.table.get(ENC)).toBe(h.ciphertext(KEY));
    expect(h.table.get(ENC)).not.toContain(KEY);
    expect(await h.key.has()).toBe(true);
    expect(await h.key.get()).toBe(KEY);
    expectNoSecretLogged(h);
  });

  it('set trims the key', async () => {
    const h = build();
    await h.key.set(`  ${KEY}\n`);
    expect(await h.key.get()).toBe(KEY);
  });

  it.each(['', '   ', '\t\n'])('set(%j) throws and stores nothing', async blank => {
    const h = build();
    await expect(h.key.set(blank)).rejects.toThrow(/empty/);
    expect(h.table.size).toBe(0);
  });

  it('a non-string from IPC throws like an empty key', async () => {
    const h = build();
    await expect(h.key.set(42 as unknown as string)).rejects.toThrow(/empty/);
    expect(h.table.size).toBe(0);
  });

  it('encryption unavailable: set throws a clear error and stores nothing (no plaintext fallback)', async () => {
    const h = build({[ENC]: 'previous'});
    h.fault.available = false;
    await expect(h.key.set(KEY)).rejects.toThrow('Secure storage is unavailable');
    expect(Object.fromEntries(h.table)).toEqual({[ENC]: 'previous'});
  });

  it('encryptString throwing: set throws a value-free error and stores nothing', async () => {
    const h = build();
    h.fault.encryptThrows = true;
    let err: unknown;
    try { await h.key.set(KEY); } catch (e) { err = e; }
    expect((err as Error).message).toBe('Encrypting the Serper API key failed');
    expect((err as Error).message).not.toContain(KEY);
    expect(h.table.size).toBe(0);
  });

  it('set replaces an earlier key and supersedes a legacy plaintext row', async () => {
    const h = build({[LEGACY]: 'old-plain'});
    await h.key.set('first');
    await h.key.set(KEY);
    expect(await h.key.get()).toBe(KEY);
    expect(h.table.has(LEGACY)).toBe(false);
  });

  it('clear deletes the _enc row and any legacy plaintext row, and keeps other settings', async () => {
    const h = build({[LEGACY]: 'old-plain', themeMode: 'dark'});
    await h.key.set(KEY);
    h.table.set(LEGACY, 'old-plain');
    await h.key.clear();
    expect(Object.fromEntries(h.table)).toEqual({themeMode: 'dark'});
    expect(await h.key.has()).toBe(false);
  });
});

describe('SerperKey — a stored key that does not decrypt', () => {
  it('decryptString throwing (another user / machine): get null, has false, warned once without the value', async () => {
    const h = build();
    await h.key.set(KEY);
    h.fault.decryptThrows = true;
    expect(await h.key.get()).toBeNull();
    expect(await h.key.has()).toBe(false);
    expect(await h.key.get()).toBeNull();
    expect(h.logs.filter(l => l.type === 'warn')).toHaveLength(1);
    expectNoSecretLogged(h);
    expect(h.table.has(ENC)).toBe(true);   // left for the user to replace, not silently dropped
  });

  it('garbage in the _enc row: get null', async () => {
    const h = build({[ENC]: 'not-base64-ciphertext!!'});
    expect(await h.key.get()).toBeNull();
    expect(await h.key.has()).toBe(false);
  });

  it('a row that decrypts to an empty string: get null, has false', async () => {
    const h = build();
    h.table.set(ENC, h.ciphertext(''));
    expect(await h.key.get()).toBeNull();
    expect(await h.key.has()).toBe(false);
  });

  it('an empty _enc row: get null without calling decrypt', async () => {
    const h = build({[ENC]: ''});
    h.fault.decryptThrows = true;
    expect(await h.key.get()).toBeNull();
    expect(h.logs).toEqual([]);
  });

  it('a successful set re-arms the one-time decrypt warning', async () => {
    const h = build();
    await h.key.set(KEY);
    h.fault.decryptThrows = true;
    await h.key.get();
    h.fault.decryptThrows = false;
    await h.key.set(KEY);
    h.fault.decryptThrows = true;
    await h.key.get();
    expect(h.logs.filter(l => l.type === 'warn')).toHaveLength(2);
  });
});

describe('SerperKey.migratePlaintext', () => {
  it('a plaintext key is encrypted into _enc and the plaintext row DELETED', async () => {
    const h = build({[LEGACY]: KEY, themeMode: 'dark'});
    await h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({themeMode: 'dark', [ENC]: h.ciphertext(KEY)});
    expect(await h.key.get()).toBe(KEY);
    expectNoSecretLogged(h);
  });

  it('the plaintext is trimmed on the way', async () => {
    const h = build({[LEGACY]: ` ${KEY} `});
    await h.key.migratePlaintext();
    expect(await h.key.get()).toBe(KEY);
  });

  it('is idempotent: a second run changes nothing and logs nothing', async () => {
    const h = build({[LEGACY]: KEY});
    await h.key.migratePlaintext();
    const after = Object.fromEntries(h.table);
    const logged = h.logs.length;
    await h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual(after);
    expect(h.logs).toHaveLength(logged);
  });

  it('no plaintext row: a no-op that leaves an existing _enc row alone', async () => {
    const h = build();
    await h.key.set(KEY);
    const before = Object.fromEntries(h.table);
    await h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual(before);
  });

  it.each(['', '  '])('an empty plaintext row (%j) is just deleted — no _enc row', async blank => {
    const h = build({[LEGACY]: blank});
    h.fault.available = false;   // not even needed
    await h.key.migratePlaintext();
    expect(h.table.size).toBe(0);
  });

  it('encryption unavailable: the plaintext row stays, warned without the value; a later run migrates it', async () => {
    const h = build({[LEGACY]: KEY});
    h.fault.available = false;
    await h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({[LEGACY]: KEY});
    expect(h.logs.map(l => l.type)).toEqual(['warn']);
    expectNoSecretLogged(h);

    h.fault.available = true;
    await h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({[ENC]: h.ciphertext(KEY)});
  });

  it('encryptString throwing: the plaintext row stays, warned without the value, nothing half-written', async () => {
    const h = build({[LEGACY]: KEY});
    h.fault.encryptThrows = true;
    await expect(h.key.migratePlaintext()).resolves.toBeUndefined();
    expect(Object.fromEntries(h.table)).toEqual({[LEGACY]: KEY});
    expect(h.logs.map(l => l.type)).toEqual(['warn']);
    expectNoSecretLogged(h);
  });

  it('both rows present (an interrupted earlier run): the plaintext wins once and is deleted', async () => {
    const h = build({[LEGACY]: KEY, [ENC]: 'stale'});
    await h.key.migratePlaintext();
    expect(Object.fromEntries(h.table)).toEqual({[ENC]: h.ciphertext(KEY)});
  });
});

/** Every queued microtask and timer run — the calls in flight have reached their gate. */
const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

/** A promise to hold an in-flight safeStorage call open, and its release. */
function gate(): {promise: Promise<void>; open: () => void} {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return {promise, open};
}

describe('SerperKey — shouldReEncrypt', () => {
  const rotatedCiphertext = (plain: string) => Buffer.from(`old:${[...plain].reverse().join('')}`).toString('base64');

  it('a row flagged shouldReEncrypt is returned and re-encrypted in place', async () => {
    const h = build({[ENC]: rotatedCiphertext(KEY)});
    expect(await h.key.get()).toBe(KEY);
    expect(h.table.get(ENC)).toBe(h.ciphertext(KEY));
    expect(await h.key.has()).toBe(true);
    expectNoSecretLogged(h);
  });

  it('re-encryption failing: the key is still returned, the old row kept, warned without the value', async () => {
    const h = build({[ENC]: rotatedCiphertext(KEY)});
    h.fault.encryptThrows = true;
    expect(await h.key.get()).toBe(KEY);
    expect(h.table.get(ENC)).toBe(rotatedCiphertext(KEY));
    expect(h.logs.map(l => l.type)).toEqual(['warn']);
    expectNoSecretLogged(h);
    expect(h.logs.map(l => l.message).join('\n')).not.toContain(rotatedCiphertext(KEY));
  });

  it('a clear() landing while the flagged row decrypts is not undone by the re-encryption', async () => {
    const h = build({[ENC]: rotatedCiphertext(KEY)});
    const decrypting = gate();
    h.fault.decryptGate = decrypting.promise;
    const read = h.key.get();
    await Promise.resolve();
    await h.key.clear();
    decrypting.open();
    expect(await read).toBe(KEY);
    expect(h.table.has(ENC)).toBe(false);
  });

  it('a set() landing while the flagged row decrypts is not overwritten by the re-encryption', async () => {
    const h = build({[ENC]: rotatedCiphertext('old-key')});
    const decrypting = gate();
    h.fault.decryptGate = decrypting.promise;
    const read = h.key.get();
    await Promise.resolve();
    await h.key.set(KEY);
    decrypting.open();
    expect(await read).toBe('old-key');
    expect(h.table.get(ENC)).toBe(h.ciphertext(KEY));
  });
});

describe('SerperKey — writes apply in call order across the async calls', () => {
  it('a set() made while the startup migration encrypts lands after it — the user\'s key wins', async () => {
    const h = build({[LEGACY]: 'legacy-key'});
    const encrypting = gate();
    h.fault.encryptGate = encrypting.promise;
    const migrating = h.key.migratePlaintext();
    const saving    = h.key.set(KEY);
    await settle();
    encrypting.open();
    await Promise.all([migrating, saving]);
    expect(Object.fromEntries(h.table)).toEqual({[ENC]: h.ciphertext(KEY)});
  });

  it('a clear() made while a set() encrypts lands after it — nothing is left stored', async () => {
    const h = build();
    const encrypting = gate();
    h.fault.encryptGate = encrypting.promise;
    const saving   = h.key.set(KEY);
    const clearing = h.key.clear();
    await settle();
    encrypting.open();
    await Promise.all([saving, clearing]);
    expect(h.table.size).toBe(0);
  });

  it('a failed write does not stall the writes after it', async () => {
    const h = build();
    h.fault.available = false;
    await expect(h.key.set('first')).rejects.toThrow('Secure storage is unavailable');
    h.fault.available = true;
    await h.key.set(KEY);
    expect(await h.key.get()).toBe(KEY);
  });

  it('a read waits for the writes queued before it (the startup migration)', async () => {
    const h = build({[LEGACY]: KEY});
    const encrypting = gate();
    h.fault.encryptGate = encrypting.promise;
    void h.key.migratePlaintext();
    const read = h.key.get();
    await settle();
    encrypting.open();
    expect(await read).toBe(KEY);
  });
});
