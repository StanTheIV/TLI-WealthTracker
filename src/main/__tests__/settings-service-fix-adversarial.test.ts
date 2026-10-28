/**
 * 3.2 adversarial, round 2: the committed-write fix (F1). Persist -> side
 * effect -> broadcast ordering and the table each broadcast reflects, when side
 * effects throw odd things.
 */
import {describe, it, expect} from 'vitest';
import {SettingsService} from '@/main/settings-service';
import {parseSettings, type Settings} from '@/shared/settings';

function build(opts: {persist?: () => void; reconfigure?: () => void; reloadConfig?: () => void} = {}) {
  const calls: string[] = [];
  const sent: Settings[] = [];
  const logged: string[] = [];
  const table: Record<string, string> = {};
  const service = new SettingsService({
    store: {
      set: (k, v) => { opts.persist?.(); table[k] = v; calls.push(`persist:${k}`); },
      getAll: () => ({...table}),
    },
    broadcast: (_c, p) => { sent.push(p as Settings); calls.push('broadcast'); },
    tracking:  {reconfigure: () => { calls.push('reconfigure'); opts.reconfigure?.(); }},
    log:       {reloadConfig: () => { calls.push('reloadConfig'); opts.reloadConfig?.(); },
                error: (_f, m) => { calls.push('error'); logged.push(String(m)); }},
  });
  return {service, calls, sent, logged, table};
}

describe('F1: a throwing side effect never reorders or drops the broadcast', () => {
  it.each([undefined, null, 0, '', {}, 'boom', new Error('x')])('reconfigure throwing %j: order persist, reconfigure, error, broadcast; set resolves', thrown => {
    const h = build({reconfigure: () => { throw thrown; }});
    expect(() => h.service.set('carjackLootMs', '7000')).not.toThrow();
    expect(h.calls).toEqual(['persist:carjackLootMs', 'reconfigure', 'error', 'broadcast']);
    expect(h.sent[0].lootWindowMs.carjack).toBe(7000);
    expect(h.logged[0]).toContain('carjackLootMs');
  });

  it('a throwing reloadConfig keeps the same order for logging keys', () => {
    const h = build({reloadConfig: () => { throw undefined; }});
    h.service.set('logging.console', '{"a":1}');
    expect(h.calls).toEqual(['persist:logging.console', 'reloadConfig', 'error', 'broadcast']);
  });

  it('reconfigure always throws: each broadcast reflects the table at its moment, across different keys', () => {
    const h = build({reconfigure: () => { throw new Error('dead'); }});
    h.service.set('lowStockThreshold', '3');
    h.service.set('themeMode', 'dark');
    h.service.set('carjackLootMs', '2000');
    expect(h.sent).toEqual([
      parseSettings({lowStockThreshold: '3'}),
      parseSettings({lowStockThreshold: '3', themeMode: 'dark'}),
      parseSettings({lowStockThreshold: '3', themeMode: 'dark', carjackLootMs: '2000'}),
    ]);
    // non-engine key never reached the throwing side effect, so only 2 errors
    expect(h.calls.filter(c => c === 'error')).toHaveLength(2);
  });

  it('a throwing reconfigure for one key does not make a later logging write skip its own side effect', () => {
    let boom = true;
    const h = build({reconfigure: () => { if (boom) throw new Error('once'); }});
    h.service.set('lowStockThreshold', '1');
    boom = false;
    h.service.set('logging.file', 'x');
    expect(h.calls.slice(-3)).toEqual(['persist:logging.file', 'reloadConfig', 'broadcast']);
  });
});

describe('F1: a failing persist', () => {
  it.each([undefined, null, 'disk full', 42])('rejects with the exact thrown value %j; nothing logged, no side effect, no broadcast', thrown => {
    const h = build({persist: () => { throw thrown; }});
    let caught: unknown = Symbol('none');
    try { h.service.set('carjackLootMs', '7000'); } catch (e) { caught = e; }
    expect(caught).toBe(thrown);
    expect(h.calls).toEqual([]);
  });

  it('a failed persist leaves the next write fully working', () => {
    let fail = true;
    const h = build({persist: () => { if (fail) throw new Error('x'); }});
    expect(() => h.service.set('lowStockThreshold', '1')).toThrow('x');
    fail = false;
    h.service.set('lowStockThreshold', '2');
    expect(h.calls).toEqual(['persist:lowStockThreshold', 'reconfigure', 'broadcast']);
    expect(h.sent[0].lowStockThreshold).toBe(2);
  });
});
