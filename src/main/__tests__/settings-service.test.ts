/**
 * Tests for SettingsService: persist -> side effects -> broadcast, over a
 * Map-backed store and recording fakes (no DB, no engine).
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {SettingsService} from '@/main/settings-service';
import {ENGINE_SETTING_KEYS, parseSettings, type Settings} from '@/shared/settings';

interface Harness {
  service: SettingsService;
  /** Every call, in order: 'persist:k=v' | 'reconfigure' | 'reloadConfig' | 'error:feature' | 'broadcast:channel'. */
  calls:   string[];
  table:   Map<string, string>;
  sent:    {channel: string; payload: unknown}[];
}

function build(opts: {
  initial?:   Record<string, string>;
  persist?:   (key: string, value: string) => void;
  reconfigure?: () => void;
  reloadConfig?: () => void;
} = {}): Harness {
  const calls: string[] = [];
  const sent: {channel: string; payload: unknown}[] = [];
  const table = new Map<string, string>(Object.entries(opts.initial ?? {}));
  const service = new SettingsService({
    store: {
      set: (key, value) => {
        opts.persist?.(key, value);
        table.set(key, value);
        calls.push(`persist:${key}=${value}`);
      },
      getAll: () => Object.fromEntries(table),
    },
    broadcast: (channel, payload) => {
      sent.push({channel, payload});
      calls.push(`broadcast:${channel}`);
    },
    tracking: {reconfigure: () => { opts.reconfigure?.(); calls.push('reconfigure'); }},
    log:      {
      reloadConfig: () => { opts.reloadConfig?.(); calls.push('reloadConfig'); },
      error:        feature => { calls.push(`error:${feature}`); },
    },
  });
  return {service, calls, table, sent};
}

const count = (calls: string[], name: string) => calls.filter(c => c === name).length;

describe('SettingsService', () => {
  let h: Harness;
  beforeEach(() => { h = build(); });

  describe('ordering', () => {
    it('an engine key: persist, then reconfigure, then broadcast', () => {
      h.service.set('carjackLootMs', '7000');
      expect(h.calls).toEqual(['persist:carjackLootMs=7000', 'reconfigure', 'broadcast:settings:changed']);
    });

    it('a logging key: persist, then reloadConfig, then broadcast', () => {
      h.service.set('logging.console', 'true');
      expect(h.calls).toEqual(['persist:logging.console=true', 'reloadConfig', 'broadcast:settings:changed']);
    });

    it('any other key: persist, then broadcast only', () => {
      h.service.set('themeMode', 'dark');
      expect(h.calls).toEqual(['persist:themeMode=dark', 'broadcast:settings:changed']);
    });
  });

  describe('engine keys reconfigure the engine', () => {
    it.each([...ENGINE_SETTING_KEYS])('%s triggers exactly one reconfigure and no reloadConfig', key => {
      h.service.set(key, '1234');
      expect(count(h.calls, 'reconfigure')).toBe(1);
      expect(count(h.calls, 'reloadConfig')).toBe(0);
      expect(h.sent).toHaveLength(1);
    });
  });

  describe('logging keys reload the logger', () => {
    it.each(['logging.console', 'logging.file'])('%s triggers reloadConfig only', key => {
      h.service.set(key, 'false');
      expect(count(h.calls, 'reloadConfig')).toBe(1);
      expect(count(h.calls, 'reconfigure')).toBe(0);
      expect(h.sent).toHaveLength(1);
    });
  });

  describe('other keys trigger neither side effect but still broadcast', () => {
    it.each([
      ['rateTimeframe',   'minute'],
      ['themeMode',       'light'],
      ['language',        'de'],
      ['overlayOpacity',  '0.5'],
      ['wealthChartRange', '7d'],
      ['someUnknownKey',  'x'],
    ])('%s', (key, value) => {
      h.service.set(key, value);
      expect(count(h.calls, 'reconfigure')).toBe(0);
      expect(count(h.calls, 'reloadConfig')).toBe(0);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].channel).toBe('settings:changed');
    });
  });

  describe('broadcast', () => {
    it('sends exactly one settings:changed per set', () => {
      h.service.set('themeMode', 'dark');
      h.service.set('carjackLootMs', '7000');
      h.service.set('logging.file', 'true');
      expect(h.sent.map(s => s.channel)).toEqual(['settings:changed', 'settings:changed', 'settings:changed']);
    });

    it('the payload is parseSettings of the table after the write', () => {
      h.service.set('themeMode', 'dark');
      const payload = h.sent[0].payload as Settings;
      expect(payload.themeMode).toBe('dark');
      expect(payload).toEqual(parseSettings(Object.fromEntries(h.table)));
    });

    it('a windowed key shows up in the payload loot windows', () => {
      h.service.set('carjackLootMs', '7000');
      expect((h.sent[0].payload as Settings).lootWindowMs.carjack).toBe(7000);
    });

    it('the payload accumulates earlier writes', () => {
      h.service.set('themeMode', 'dark');
      h.service.set('rateTimeframe', 'minute');
      const payload = h.sent[1].payload as Settings;
      expect(payload.themeMode).toBe('dark');
      expect(payload.rateTimeframe).toBe('minute');
    });

    it('the payload reflects pre-existing table rows', () => {
      const pre = build({initial: {language: 'de', lowStockThreshold: '3'}});
      pre.service.set('themeMode', 'light');
      const payload = pre.sent[0].payload as Settings;
      expect(payload.language).toBe('de');
      expect(payload.lowStockThreshold).toBe(3);
      expect(payload.themeMode).toBe('light');
    });
  });

  describe('getAll', () => {
    it('returns the raw store table', () => {
      h.service.set('themeMode', 'dark');
      h.service.set('someUnknownKey', 'x');
      expect(h.service.getAll()).toEqual({themeMode: 'dark', someUnknownKey: 'x'});
    });
  });

  describe('the Serper key rows stay in main', () => {
    const SECRET = {serper_api_key: 'plain-secret', serper_api_key_enc: 'cipher-secret'};

    it('getAll filters both rows out and leaves the table untouched', () => {
      const f = build({initial: {themeMode: 'dark', ...SECRET}});
      expect(f.service.getAll()).toEqual({themeMode: 'dark'});
      expect(Object.fromEntries(f.table)).toEqual({themeMode: 'dark', ...SECRET});
    });

    it.each(Object.keys(SECRET))('set(%s) throws and persists, applies and broadcasts nothing', key => {
      expect(() => h.service.set(key, 'x')).toThrow(/not writable/);
      expect(h.calls).toEqual([]);
      expect(h.sent).toEqual([]);
      expect(h.table.has(key)).toBe(false);
    });

    it('the settings:changed payload never carries either row', () => {
      const f = build({initial: SECRET});
      f.service.set('themeMode', 'dark');
      expect(JSON.stringify(f.sent[0].payload)).not.toMatch(/secret/);
    });
  });

  describe('a failing persist', () => {
    it('throws that error and does nothing else', () => {
      const boom = new Error('disk full');
      const f = build({persist: () => { throw boom; }});
      expect(() => f.service.set('carjackLootMs', '7000')).toThrow(boom);
      expect(f.calls).toEqual([]);
      expect(f.sent).toEqual([]);
    });

    it('does nothing else for a logging key either', () => {
      const f = build({persist: () => { throw new Error('nope'); }});
      expect(() => f.service.set('logging.console', 'true')).toThrow('nope');
      expect(f.calls).toEqual([]);
    });
  });

  describe('a failing side effect (the persisted write is committed)', () => {
    it.each([
      ['reconfigure',  'carjackLootMs',   {reconfigure:  () => { throw new Error('engine'); }}],
      ['reloadConfig', 'logging.console', {reloadConfig: () => { throw new Error('logger'); }}],
    ] as const)('a throwing %s is logged once and the broadcast still goes out; set returns', (_name, key, fault) => {
      const f = build(fault);
      expect(() => f.service.set(key, 'true')).not.toThrow();
      expect(f.calls).toEqual([`persist:${key}=true`, 'error:app', 'broadcast:settings:changed']);
      expect(f.sent[0].payload).toEqual(parseSettings(Object.fromEntries(f.table)));
    });
  });

  describe('tracking without an engine', () => {
    it('a no-op reconfigure is harmless: the write still broadcasts', () => {
      const f = build({reconfigure: () => { /* no engine yet */ }});
      f.service.set('lowStockThreshold', '5');
      expect(f.sent).toHaveLength(1);
      expect((f.sent[0].payload as Settings).lowStockThreshold).toBe(5);
    });
  });
});
