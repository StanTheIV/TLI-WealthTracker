/**
 * The one write path for renderer settings: persist → side effect (engine key
 * → reconfigure, `logging.*` → reload the logger) → broadcast the parsed table
 * so both windows replace their state. A failing persist throws before any of
 * it. Main-only keys (window geometry, `last_seen_version`, …) bypass it.
 */
import type {Broadcast} from './broadcast';
import {ENGINE_SETTING_KEYS, parseSettings} from '@/shared/settings';

export interface SettingsServiceDeps {
  /** The raw settings table. */
  store:     {set(key: string, value: string): void; getAll(): Record<string, string>};
  broadcast: Broadcast;
  /** Re-reads the engine keys from the table; a no-op without a running engine. */
  tracking:  {reconfigure(): void};
  /** Re-reads the `logging.*` keys from the table. */
  log:       {reloadConfig(): void};
}

const LOGGING_PREFIX = 'logging.';

export class SettingsService {
  constructor(private readonly _deps: SettingsServiceDeps) {}

  getAll(): Record<string, string> {
    return this._deps.store.getAll();
  }

  set(key: string, value: string): void {
    const {store, broadcast, tracking, log} = this._deps;
    store.set(key, value);
    if (ENGINE_SETTING_KEYS.has(key))         tracking.reconfigure();
    else if (key.startsWith(LOGGING_PREFIX))  log.reloadConfig();
    broadcast('settings:changed', parseSettings(store.getAll()));
  }
}
