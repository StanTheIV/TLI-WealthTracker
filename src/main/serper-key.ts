/**
 * The Serper API key, main-only: encrypted with safeStorage (Windows DPAPI, per
 * OS user) as base64 under `serper_api_key_enc`. The renderer gets has/set/clear,
 * never the value; SettingsService hides both rows from the generic channels.
 * Encryption unavailable → saving throws, never a plaintext fallback. Never log
 * the key or its ciphertext.
 *
 * Uses the SYNC safeStorage API (all Electron 36 has; deprecated in 45, removed
 * in 46) — the async upgrade is a change to this file and its wiring only.
 */
import type {Logger} from './logger';

/** The encrypted key's settings row. */
export const SERPER_KEY_SETTING        = 'serper_api_key_enc';
/** The pre-5.3 plaintext row; only `migratePlaintext` reads it. */
export const LEGACY_SERPER_KEY_SETTING = 'serper_api_key';
/** Rows no renderer may read or write through the generic settings channels. */
export const SERPER_SETTING_KEYS: ReadonlySet<string> = new Set([SERPER_KEY_SETTING, LEGACY_SERPER_KEY_SETTING]);

export interface SerperKeyDeps {
  /** electron `safeStorage` (sync API). */
  crypto: {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
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

  constructor(private readonly _deps: SerperKeyDeps) {}

  /** True when a stored key decrypts to a non-empty string. */
  has(): boolean {
    return this.get() !== null;
  }

  /** The decrypted key; null when none is stored or it doesn't decrypt (another user/machine). */
  get(): string | null {
    const stored = this._deps.store.get(SERPER_KEY_SETTING);
    if (!stored) return null;
    let key: string;
    try {
      key = this._deps.crypto.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      if (!this._decryptWarned) {
        this._decryptWarned = true;
        this._deps.log.warn('app', 'The stored Serper API key could not be decrypted — save it again');
      }
      return null;
    }
    return key === '' ? null : key;
  }

  /** Encrypt and store `key` (trimmed). Throws — storing nothing — when it is
   *  empty or encryption is unavailable / fails. Supersedes a legacy plaintext row. */
  set(key: string): void {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (trimmed === '') throw new Error('The Serper API key is empty');
    this._deps.store.set(SERPER_KEY_SETTING, this._encrypt(trimmed));
    this._deps.store.delete(LEGACY_SERPER_KEY_SETTING);
    this._decryptWarned = false;
    this._deps.log.info('app', 'Serper API key saved (encrypted)');
  }

  /** Remove the key — the encrypted row and any legacy plaintext one. */
  clear(): void {
    this._deps.store.delete(SERPER_KEY_SETTING);
    this._deps.store.delete(LEGACY_SERPER_KEY_SETTING);
    this._deps.log.info('app', 'Serper API key removed');
  }

  /** Startup, after the DB is open: the pre-5.3 plaintext row is encrypted and
   *  DELETED (an empty one just deleted). Encryption unavailable → it stays, warned. */
  migratePlaintext(): void {
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
      encrypted = this._encrypt(trimmed);
    } catch (err) {
      log.warn('app', `${(err as Error).message} — the plaintext Serper API key was left in place, to migrate on a later start`);
      return;
    }
    store.set(SERPER_KEY_SETTING, encrypted);
    store.delete(LEGACY_SERPER_KEY_SETTING);
    log.info('app', 'Serper API key migrated to encrypted storage');
  }

  /** base64 ciphertext; throws a value-free Error when encryption is unavailable or fails. */
  private _encrypt(plainText: string): string {
    const {crypto} = this._deps;
    if (!crypto.isEncryptionAvailable()) throw new Error('Secure storage is unavailable');
    try {
      return crypto.encryptString(plainText).toString('base64');
    } catch {
      throw new Error('Encrypting the Serper API key failed');
    }
  }
}
