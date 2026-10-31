/**
 * The one write path for renderer settings: persist → side effect (engine key
 * → reconfigure, `logging.*` → reload the logger) → broadcast the parsed table
 * so both windows replace their state (then `wealth:changed` for the tax key).
 * A failing persist throws before any of it. Once persisted the write is
 * committed: a failing side effect is logged and the broadcast still goes out.
 * Main-only keys (window geometry, `last_seen_version`, …) bypass it. The
 * Serper key rows are hidden from `getAll` and refused by `set` (SerperKey).
 */
import type {Broadcast} from './broadcast';
import type {Logger} from './logger';
import {SERPER_SETTING_KEYS} from './serper-key';
import {describeError} from '@/shared/describe-error';
import {ENGINE_SETTING_KEYS, SETTING_KEYS, parseSettings} from '@/shared/settings';

export interface SettingsServiceDeps {
  /** The raw settings table. */
  store:     {set(key: string, value: string): void; getAll(): Record<string, string>};
  broadcast: Broadcast;
  /** Re-reads the engine keys from the table; a no-op without a running engine. */
  tracking:  {reconfigure(): void};
  /** `reloadConfig` re-reads the `logging.*` keys from the table. */
  log:       Pick<Logger, 'reloadConfig' | 'error'>;
}

const LOGGING_PREFIX = 'logging.';

export class SettingsService {
  constructor(private readonly _deps: SettingsServiceDeps) {}

  /** The raw table for a renderer — without the Serper key rows. */
  getAll(): Record<string, string> {
    const all = {...this._deps.store.getAll()};
    for (const key of SERPER_SETTING_KEYS) delete all[key];
    return all;
  }

  set(key: string, value: string): void {
    const {store, broadcast, tracking, log} = this._deps;
    if (SERPER_SETTING_KEYS.has(key)) throw new Error(`Setting '${key}' is not writable here`);
    store.set(key, value);
    try {
      if (ENGINE_SETTING_KEYS.has(key))         tracking.reconfigure();
      else if (key.startsWith(LOGGING_PREFIX))  log.reloadConfig();
    } catch (err) {
      log.error('app', `Applying setting '${key}' failed: ${describeError(err)}`);
    }
    broadcast('settings:changed', parseSettings(store.getAll()));
    // Main values the displayed wealth with the tax: every window must re-fetch it.
    if (key === SETTING_KEYS.auctionTaxEnabled) broadcast('wealth:changed');
  }
}
