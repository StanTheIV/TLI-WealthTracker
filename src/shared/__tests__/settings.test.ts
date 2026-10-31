import {describe, expect, it} from 'vitest';
import {MECHANICS, mechanic} from '@/shared/mechanics';
import {
  DEFAULT_SETTINGS, ENGINE_SETTING_KEYS, SETTING_KEYS, parsePositiveInt, parseSettings,
} from '@/shared/settings';

const WINDOWED = MECHANICS.flatMap(m => (m.window ? [m] : []));

describe('defaults', () => {
  it('an empty table parses to DEFAULT_SETTINGS', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('the loot windows are exactly the windowed MECHANICS rows, at their table defaults', () => {
    expect(DEFAULT_SETTINGS.lootWindowMs).toEqual(Object.fromEntries(WINDOWED.map(m => [m.key, m.window.defaultMs])));
  });

  it('every field but the loot windows has a DB key', () => {
    expect(Object.keys(SETTING_KEYS).sort())
      .toEqual(Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'lootWindowMs').sort());
  });
});

describe('field parse', () => {
  it.each(['clickThroughWhileRunning', 'pauseTotalTimerInTown', 'showEventFeed'] as const)(
    '%s: only "true" is true',
    (field) => {
      expect(parseSettings({[SETTING_KEYS[field]]: 'true'})[field]).toBe(true);
      for (const raw of ['false', 'TRUE', '1', '', ' true']) {
        expect(parseSettings({[SETTING_KEYS[field]]: raw})[field], raw).toBe(false);
      }
      expect(parseSettings({})[field]).toBe(false);
    },
  );

  it('auctionTaxEnabled defaults ON: only "false" opts out', () => {
    expect(parseSettings({}).auctionTaxEnabled).toBe(true);
    expect(parseSettings({auctionTaxEnabled: 'true'}).auctionTaxEnabled).toBe(true);
    expect(parseSettings({auctionTaxEnabled: 'false'}).auctionTaxEnabled).toBe(false);
  });

  it('rateTimeframe: a known value or "hour"', () => {
    expect(parseSettings({rateTimeframe: 'minute'}).rateTimeframe).toBe('minute');
    expect(parseSettings({rateTimeframe: 'hour'}).rateTimeframe).toBe('hour');
    for (const raw of ['Minute', '', 'day']) expect(parseSettings({rateTimeframe: raw}).rateTimeframe, raw).toBe('hour');
  });

  it('themeMode: a known value or "system"', () => {
    for (const mode of ['system', 'dark', 'light'] as const) {
      expect(parseSettings({themeMode: mode}).themeMode).toBe(mode);
    }
    for (const raw of ['Dark', '', 'auto']) expect(parseSettings({themeMode: raw}).themeMode, raw).toBe('system');
  });

  it.each([
    [undefined, 0.9], ['', 0.9], ['abc', 0.9], ['NaN', 0.9], ['Infinity', 0.9], ['-Infinity', 0.9],
    ['0.5', 0.5], ['0', 0], ['1', 1], ['1.5', 1], ['-0.2', 0],
  ])('overlayOpacity %j → %d', (raw, opacity) => {
    expect(parseSettings(raw === undefined ? {} : {overlayOpacity: raw}).overlayOpacity).toBe(opacity);
  });

  it('strings pass through as stored; missing → the default', () => {
    const s = parseSettings({torchlightPath: 'C:/TL', language: 'de'});
    expect([s.torchlightPath, s.language]).toEqual(['C:/TL', 'de']);
    expect(parseSettings({language: ''}).language).toBe('');             // `??`: only a missing key defaults
  });

  it.each([
    [undefined, 0], ['', 0], ['0', 0], ['0.5', 0], ['3.7', 3], ['8', 8], ['-1', 0], ['abc', 0], ['Infinity', 0],
  ])('lowStockThreshold %j → %d', (raw, n) => {
    expect(parseSettings(raw === undefined ? {} : {lowStockThreshold: raw}).lowStockThreshold).toBe(n);
  });

  it.each([
    [undefined, 5_000], ['', 5_000], ['0', 5_000], ['-5', 5_000], ['abc', 5_000], ['0.5', 5_000],
    ['Infinity', 5_000], ['NaN', 5_000], ['7000', 7_000], ['7000.9', 7_000], [' 7000 ', 7_000], ['1', 1],
  ])('window %j → %d', (raw, ms) => {
    expect(parseSettings(raw === undefined ? {} : {carjackLootMs: raw}).lootWindowMs.carjack).toBe(ms);
  });

  it.each(WINDOWED.map(m => m.key))('%s: its row\'s setting key sets its window, and only its', (type) => {
    const s = parseSettings({[mechanic(type).window.settingKey]: '7000'});
    for (const m of WINDOWED) {
      expect(s.lootWindowMs[m.key], m.key).toBe(m.key === type ? 7000 : m.window.defaultMs);
    }
  });
});

describe('ENGINE_SETTING_KEYS', () => {
  it('is every windowed row\'s setting key plus the low-stock threshold', () => {
    expect([...ENGINE_SETTING_KEYS].sort())
      .toEqual([...WINDOWED.map(m => m.window.settingKey), 'lowStockThreshold'].sort());
  });

  // Drift guard: a key outside the set must not reach what the engine reads,
  // or a change to it would not reconfigure the engine.
  it('no other key moves an engine-read field', () => {
    const others = [
      ...Object.values(SETTING_KEYS), 'wealthChartRange', 'logging.console', 'logging.file', 'serper_api_key',
      'carjackLootSec', 'sandlordLootMs', 'lowStock',
    ].filter(k => !ENGINE_SETTING_KEYS.has(k));
    expect(others.length).toBeGreaterThan(0);
    for (const key of others) {
      const s = parseSettings({[key]: '7'});
      expect(s.lootWindowMs, key).toEqual(DEFAULT_SETTINGS.lootWindowMs);
      expect(s.lowStockThreshold, key).toBe(DEFAULT_SETTINGS.lowStockThreshold);
    }
  });
});

describe('parsePositiveInt', () => {
  it('allowZero accepts 0 and still rejects negatives', () => {
    expect(parsePositiveInt('0', 9, true)).toBe(0);
    expect(parsePositiveInt('0.5', 9, true)).toBe(0);
    expect(parsePositiveInt('-1', 9, true)).toBe(9);
    expect(parsePositiveInt('-0.5', 9, true)).toBe(9);
    expect(parsePositiveInt('abc', 9, true)).toBe(9);
    expect(parsePositiveInt(undefined, 9, true)).toBe(9);
    expect(parsePositiveInt('3.7', 9, true)).toBe(3);
  });

  it('without allowZero the minimum is 1', () => {
    expect(parsePositiveInt('0', 9, false)).toBe(9);
    expect(parsePositiveInt('0.9', 9, false)).toBe(9);
    expect(parsePositiveInt('1', 9, false)).toBe(1);
  });
});
