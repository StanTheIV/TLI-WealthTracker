/**
 * 3.2 adversarial: parseSettings against hostile raw tables, number-format
 * edge cases, result isolation (a fresh object per call, DEFAULT_SETTINGS
 * never aliased) and ENGINE_SETTING_KEYS coverage.
 */
import {describe, it, expect} from 'vitest';
import {
  DEFAULT_SETTINGS, ENGINE_SETTING_KEYS, SETTING_KEYS, parsePositiveInt, parseSettings,
  type Settings,
} from '@/shared/settings';
import {MECHANICS, WINDOWED_MECHANICS} from '@/shared/mechanics';

const snapshotDefaults = () => JSON.stringify(DEFAULT_SETTINGS);
const win = (v: string) => parseSettings({carjackLootMs: v}).lootWindowMs.carjack;
const opacity = (v: string) => parseSettings({overlayOpacity: v}).overlayOpacity;
const lowStock = (v: string) => parseSettings({lowStockThreshold: v}).lowStockThreshold;

describe('parseSettings: hostile tables', () => {
  it('prototype-ish keys are ignored and nothing is polluted', () => {
    const raw = JSON.parse(
      '{"__proto__": "x", "constructor": "y", "toString": "z", "hasOwnProperty": "w", "carjackLootMs": "7000"}',
    ) as Record<string, string>;
    const s = parseSettings(raw);
    expect(s.lootWindowMs.carjack).toBe(7000);
    expect(s.language).toBe('en');
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['carjackLootMs']).toBeUndefined();
  });

  it('a null-prototype table parses like an ordinary one', () => {
    const raw = Object.assign(Object.create(null) as Record<string, string>, {themeMode: 'dark', lowStockThreshold: '3'});
    const s = parseSettings(raw);
    expect(s.themeMode).toBe('dark');
    expect(s.lowStockThreshold).toBe(3);
    expect(parseSettings(Object.create(null) as Record<string, string>)).toEqual(DEFAULT_SETTINGS);
  });

  it('inherited (prototype) properties on the table are read like own ones (pinned: no hasOwn guard)', () => {
    const raw = Object.create({language: 'de'}) as Record<string, string>;
    expect(parseSettings(raw).language).toBe('de');
  });

  it('an empty table is exactly DEFAULT_SETTINGS', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('never throws on a table of junk values for every typed key', () => {
    const junk = ['', ' ', 'null', 'undefined', 'NaN', 'Infinity', '-Infinity', '{}', '[]', '\u0000', 'x'.repeat(1e6), '🔥'];
    const keys = [
      ...Object.values(SETTING_KEYS),
      ...WINDOWED_MECHANICS.map(m => m.window.settingKey),
    ];
    for (const v of junk) {
      const raw = Object.fromEntries(keys.map(k => [k, v]));
      expect(() => parseSettings(raw)).not.toThrow();
    }
  });

  it('a very long string is carried verbatim into the string fields', () => {
    const big = 'a'.repeat(1_000_000);
    const s = parseSettings({serper_api_key: big, torchlightPath: big});
    expect(s.serperApiKey).toBe(big);
    expect(s.torchlightPath).toBe(big);
  });

  it('non-string values smuggled in (a corrupt table) do not throw', () => {
    const raw = {overlayOpacity: 0.5, lowStockThreshold: 4, carjackLootMs: 6000, showEventFeed: true} as unknown as Record<string, string>;
    const s = parseSettings(raw);
    expect(s.overlayOpacity).toBe(0.5);
    expect(s.lowStockThreshold).toBe(4);
    expect(s.lootWindowMs.carjack).toBe(6000);
    expect(s.showEventFeed).toBe(false); // only the string 'true' counts
  });
});

describe('parseSettings: number formats', () => {
  it.each([
    ['5e3', 5000], ['0x10', 16], ['  7  ', 7], ['1.9', 1], ['+8', 8], ['0b11', 3], ['1_000', 5000],
    ['0.4', 5000], ['0', 5000], ['-1', 5000], ['', 5000], ['   ', 5000], ['abc', 5000], ['1e400', 5000],
    ['Infinity', 5000], ['-0', 5000], ['0.9999', 5000],
  ])('loot window %j -> %d', (v, expected) => {
    expect(win(v)).toBe(expected);
  });

  it('huge finite windows are accepted unbounded (pinned: no upper cap)', () => {
    expect(win('1e21')).toBe(1e21);
    expect(win('9007199254740993')).toBe(9007199254740992);
  });

  it.each([
    ['5e3', 1], ['0x10', 1], ['0.5', 0.5], [' 0.25 ', 0.25], ['-5', 0], ['2', 1],
    ['1e-400', 0], ['abc', 0.9], ['', 0.9], ['Infinity', 0.9], ['-Infinity', 0.9],
  ])('opacity %j -> %d', (v, expected) => {
    expect(opacity(v)).toBe(expected);
  });

  it('opacity -0 is normalised to +0 by the clamp', () => {
    expect(Object.is(opacity('-0'), 0)).toBe(true);
  });

  it('opacity whitespace-only reads as 0 (pinned: truthy string, Number("  ") = 0), unlike empty', () => {
    expect(opacity('   ')).toBe(0);
    expect(opacity('')).toBe(0.9);
  });

  it.each([['0', 0], ['3', 3], ['5e1', 50], ['-1', 0], ['-0.5', 0], ['0.9', 0], ['abc', 0], [' 4 ', 4], ['', 0]])(
    'lowStock %j -> %d', (v, expected) => {
      expect(lowStock(v)).toBe(expected);
    });

  it('lowStock "-0" yields negative zero (pinned; surfaced by Object.is)', () => {
    // floor(-0) = -0 and -0 >= 0: the "0" threshold leaks out as -0. Harmless for
    // comparisons; String(-0) === '0' so the echo through the DB is clean.
    expect(Object.is(lowStock('-0'), -0)).toBe(true);
    expect(String(lowStock('-0'))).toBe('0');
  });

  it('parsePositiveInt fallback is returned untouched (even a non-integer fallback)', () => {
    expect(parsePositiveInt(undefined, 2.5, false)).toBe(2.5);
    expect(parsePositiveInt('x', -3, true)).toBe(-3);
  });
});

describe('parseSettings: enums, booleans and strings', () => {
  it('booleans are strict: only the exact lowercase literals count', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', ' true', 'true ', '']) {
      const s = parseSettings({clickThroughWhileRunning: v, showEventFeed: v, pauseTotalTimerInTown: v});
      expect(s.clickThroughWhileRunning).toBe(false);
      expect(s.showEventFeed).toBe(false);
      expect(s.pauseTotalTimerInTown).toBe(false);
    }
  });

  it('auctionTaxEnabled: only the exact "false" opts out', () => {
    for (const v of ['FALSE', 'False', '0', ' false', 'no', '']) {
      expect(parseSettings({auctionTaxEnabled: v}).auctionTaxEnabled).toBe(true);
    }
    expect(parseSettings({auctionTaxEnabled: 'false'}).auctionTaxEnabled).toBe(false);
  });

  it('enums are case/whitespace-strict and fall back to the default', () => {
    expect(parseSettings({themeMode: 'Dark'}).themeMode).toBe('system');
    expect(parseSettings({themeMode: ' dark'}).themeMode).toBe('system');
    expect(parseSettings({rateTimeframe: 'Minute'}).rateTimeframe).toBe('hour');
    expect(parseSettings({rateTimeframe: 'toString'}).rateTimeframe).toBe('hour');
    expect(parseSettings({themeMode: 'light'}).themeMode).toBe('light');
  });

  it('an EMPTY language is kept as "" (pinned: ?? only defaults a missing key; i18n gets "")', () => {
    // Questionable: every other typed field treats an unusable value as default; an empty
    // language string flows to i18n.changeLanguage(''). Reachable via setLanguage('').
    expect(parseSettings({language: ''}).language).toBe('');
  });

  it('an empty torchlightPath / serper key are kept as ""', () => {
    expect(parseSettings({torchlightPath: '', serper_api_key: ''}))
      .toMatchObject({torchlightPath: '', serperApiKey: ''});
  });

  it('the DB key of serperApiKey is snake_case, not the field name', () => {
    expect(parseSettings({serperApiKey: 'nope'}).serperApiKey).toBe('');
    expect(parseSettings({serper_api_key: 'yes'}).serperApiKey).toBe('yes');
  });
});

describe('parseSettings: result isolation', () => {
  it('every call returns a fresh object and a fresh lootWindowMs', () => {
    const a = parseSettings({});
    const b = parseSettings({});
    expect(a).not.toBe(b);
    expect(a.lootWindowMs).not.toBe(b.lootWindowMs);
    expect(a.lootWindowMs).not.toBe(DEFAULT_SETTINGS.lootWindowMs);
    expect(a).not.toBe(DEFAULT_SETTINGS);
  });

  it('mutating a result (through a cast) leaks into neither DEFAULT_SETTINGS nor the next parse', () => {
    const before = snapshotDefaults();
    const a = parseSettings({}) as {-readonly [K in keyof Settings]: Settings[K]};
    (a.lootWindowMs as Record<string, number>)['carjack'] = 1;
    (a.lootWindowMs as Record<string, number>)['injected'] = 1;
    a.language = 'zz';
    expect(snapshotDefaults()).toBe(before);
    const b = parseSettings({});
    expect(b.lootWindowMs.carjack).toBe(5000);
    expect(b.language).toBe('en');
    expect('injected' in b.lootWindowMs).toBe(false);
  });

  it('parsing a populated table never mutates DEFAULT_SETTINGS or the raw table', () => {
    const before = snapshotDefaults();
    const raw = Object.freeze({carjackLootMs: '1', themeMode: 'dark', lowStockThreshold: '9', overlayOpacity: '0.1'});
    expect(() => parseSettings(raw)).not.toThrow();
    expect(snapshotDefaults()).toBe(before);
  });

  it('DEFAULT_SETTINGS.lootWindowMs carries exactly the windowed mechanics at their defaultMs', () => {
    const expected = Object.fromEntries(MECHANICS.flatMap(m => (m.window ? [[m.key, m.window.defaultMs]] : [])));
    expect(DEFAULT_SETTINGS.lootWindowMs).toEqual(expected);
    expect(Object.keys(parseSettings({}).lootWindowMs).sort()).toEqual(Object.keys(expected).sort());
  });

  it('each windowed key reads only its own row (no cross-talk)', () => {
    for (const m of WINDOWED_MECHANICS) {
      const s = parseSettings({[m.window.settingKey]: '1234'});
      for (const o of WINDOWED_MECHANICS) {
        expect(s.lootWindowMs[o.key]).toBe(o.key === m.key ? 1234 : o.window.defaultMs);
      }
    }
  });
});

describe('ENGINE_SETTING_KEYS', () => {
  it('is exactly the windowed setting keys plus lowStockThreshold', () => {
    expect([...ENGINE_SETTING_KEYS].sort()).toEqual(
      [...WINDOWED_MECHANICS.map(m => m.window.settingKey), 'lowStockThreshold'].sort());
  });

  it('every engine key moves what the engine reads (lootWindowMs or lowStockThreshold)', () => {
    const base = parseSettings({});
    for (const key of ENGINE_SETTING_KEYS) {
      const changed = parseSettings({[key]: '4321'});
      expect(JSON.stringify(changed.lootWindowMs) !== JSON.stringify(base.lootWindowMs)
        || changed.lowStockThreshold !== base.lowStockThreshold).toBe(true);
    }
  });

  it('no non-engine typed key changes what the engine reads', () => {
    const base = parseSettings({});
    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      if (ENGINE_SETTING_KEYS.has(key)) continue;
      const changed = parseSettings({[key]: 'true'});
      expect(changed.lootWindowMs, field).toEqual(base.lootWindowMs);
      expect(changed.lowStockThreshold, field).toBe(base.lowStockThreshold);
    }
  });
});
