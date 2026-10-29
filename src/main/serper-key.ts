/**
 * The Serper API key, main-only: encrypted with safeStorage (Windows DPAPI, per
 * OS user) as base64 under `serper_api_key_enc`. The renderer gets has/set/clear,
 * never the value; SettingsService hides both rows from the generic channels.
 * Encryption unavailable → saving throws, never a plaintext fallback. Never log
 * the key or its ciphertext.
 *
 * Uses the ASYNC safeStorage API (Electron 45+; the sync one is removed in 46).
 * Rows written by the sync API decrypt with it. Writes (set / clear / the
 * startup migration / a re-encrypt) run one at a time in call order, and reads
 * wait for the writes queued before them — what the sync API gave for free.
 */
import type {Logger} from './logger';

/** The encrypted key's settings row. */
export const SERPER_KEY_SETTING        = 'serper_api_key_enc';
/** The pre-5.3 plaintext row; only `migratePlaintext` reads it. */
export const LEGACY_SERPER_KEY_SETTING = 'serper_api_key';
/** Rows no renderer may read or write through the generic settings channels. */
export const SERPER_SETTING_KEYS: ReadonlySet<string> = new Set([SERPER_KEY_SETTING, LEGACY_SERPER_KEY_SETTING]);

export interface SerperKeyDeps {
  /** electron `safeStorage` (async API). */
  crypto: {
    isAsyncEncryptionAvailable(): Promise<boolean>;
    encryptStringAsync(plainText: string): Promise<Buffer>;
    decryptStringAsync(encrypted: Buffer): Promise<{result: string; shouldReEncrypt: boolean}>;
  };
  /** The raw settings table. */
  store: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
  };
  log: Pick<Logger, 'info' | 'warn'>;
}

export class SerperKey {
  /** A failed decrypt is warned about once, not on every lookup. */
  private _decryptWarned = false;
  /** The last queued write; settles (never rejects) when it is done. */
  private _writes: Promise<void> = Promise.resolve();

  constructor(private readonly _deps: SerperKeyDeps) {}

  /** True when a stored key decrypts to a non-empty string. */
  async has(): Promise<boolean> {
    return (await this.get()) !== null;
  }

  /** The decrypted key; null when none is stored or it doesn't decrypt (another
   *  user/machine). A row safeStorage flags `shouldReEncrypt` is re-encrypted
   *  and stored — unless a write replaced it meanwhile; a failure only warns. */
  async get(): Promise<string | null> {
    await this._writes;
    const {store, crypto, log} = this._deps;
    const stored = store.get(SERPER_KEY_SETTING);
    if (!stored) return null;
    let decrypted: {result: string; shouldReEncrypt: boolean};
    try {
      decrypted = await crypto.decryptStringAsync(Buffer.from(stored, 'base64'));
    } catch {
      if (!this._decryptWarned) {
        this._decryptWarned = true;
        log.warn('app', 'The stored Serper API key could not be decrypted — save it again');
      }
      return null;
    }
    const key = decrypted.result;
    if (key === '') return null;
    if (decrypted.shouldReEncrypt) {
      await this._serial(async () => {
        const encrypted = await this._encrypt(key);
        if (store.get(SERPER_KEY_SETTING) === stored) store.set(SERPER_KEY_SETTING, encrypted);
      }).catch((err: unknown) => {
        log.warn('app', `${(err as Error).message} — the Serper API key was not re-encrypted`);
      });
    }
    return key;
  }

  /** Encrypt and store `key` (trimmed). Rejects — storing nothing — when it is
   *  empty or encryption is unavailable / fails. Supersedes a legacy plaintext row. */
  set(key: string): Promise<void> {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (trimmed === '') return Promise.reject(new Error('The Serper API key is empty'));
    return this._serial(async () => {
      const encrypted = await this._encrypt(trimmed);
      this._deps.store.set(SERPER_KEY_SETTING, encrypted);
      this._deps.store.delete(LEGACY_SERPER_KEY_SETTING);
      this._decryptWarned = false;
      this._deps.log.info('app', 'Serper API key saved (encrypted)');
    });
  }

  /** Remove the key — the encrypted row and any legacy plaintext one. */
  clear(): Promise<void> {
    return this._serial(async () => {
      this._deps.store.delete(SERPER_KEY_SETTING);
      this._deps.store.delete(LEGACY_SERPER_KEY_SETTING);
      this._deps.log.info('app', 'Serper API key removed');
    });
  }

  /** Startup, after the DB is open: the pre-5.3 plaintext row is encrypted and
   *  DELETED (an empty one just deleted). Encryption unavailable → it stays, warned. */
  migratePlaintext(): Promise<void> {
    return this._serial(async () => {
      const {store, log} = this._deps;
      const plain = store.get(LEGACY_SERPER_KEY_SETTING);
      if (plain === undefined) return;
      const trimmed = plain.trim();
      if (trimmed === '') {
        store.delete(LEGACY_SERPER_KEY_SETTING);
        return;
      }
      let encrypted: string;
      try {
        encrypted = await this._encrypt(trimmed);
      } catch (err) {
        log.warn('app', `${(err as Error).message} — the plaintext Serper API key was left in place, to migrate on a later start`);
        return;
      }
      store.set(SERPER_KEY_SETTING, encrypted);
      store.delete(LEGACY_SERPER_KEY_SETTING);
      log.info('app', 'Serper API key migrated to encrypted storage');
    });
  }

  /** Run `write` after every write queued before it; its own outcome is returned. */
  private _serial(write: () => Promise<void>): Promise<void> {
    const run = this._writes.then(write);
    this._writes = run.catch(() => undefined);
    return run;
  }

  /** base64 ciphertext; rejects with a value-free Error when encryption is unavailable or fails. */
  private async _encrypt(plainText: string): Promise<string> {
    const {crypto} = this._deps;
    if (!(await crypto.isAsyncEncryptionAvailable())) throw new Error('Secure storage is unavailable');
    try {
      return (await crypto.encryptStringAsync(plainText)).toString('base64');
    } catch {
      throw new Error('Encrypting the Serper API key failed');
    }
  }
}
