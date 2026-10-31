/**
 * A side effect throwing a value with no string conversion (null-prototype
 * object, Symbol) must not make the catch block itself throw: the committed
 * write still broadcasts and set() returns.
 */
import {describe, it, expect} from 'vitest';
import {SettingsService} from '@/main/settings-service';

describe('a side effect throwing an unstringifiable value', () => {
  it.each([['null-prototype object', () => Object.create(null)], ['symbol', () => Symbol('s')]])('%s: set resolves and still broadcasts', (_n, make) => {
    const sent: unknown[] = [];
    const service = new SettingsService({
      store: {set: () => undefined, getAll: () => ({})},
      broadcast: (_c, p) => { sent.push(p); },
      tracking: {reconfigure: () => { throw make(); }},
      log: {reloadConfig: () => undefined, error: () => undefined},
    });
    expect(() => service.set('lowStockThreshold', '1')).not.toThrow();
    expect(sent).toHaveLength(1);
  });
});
