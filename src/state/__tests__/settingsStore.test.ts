/**
 * 3.2 adversarial: the renderer settingsStore in Node. window.electronAPI is a
 * stub and '@/i18n' is mocked; the module is re-imported per test because the
 * store keeps a module-level "subscribed" flag.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {MECHANICS, WINDOWED_MECHANICS, type WindowedSeasonalType} from '@/shared/mechanics';
import {DEFAULT_SETTINGS, parseSettings, type Settings} from '@/shared/settings';

const changeLanguage = vi.fn((_lng: string) => Promise.resolve());
vi.mock('@/i18n', () => ({default: {changeLanguage: (lng: string) => changeLanguage(lng)}}));

interface Api {
  getAll:        ReturnType<typeof vi.fn>;
  set:           ReturnType<typeof vi.fn>;
  onChanged:     ReturnType<typeof vi.fn>;
  checkLogFile:  ReturnType<typeof vi.fn>;
  /** Push a `settings:changed` echo to every registered listener. */
  emit:          (s: Settings) => void;
}

function stubApi(table: Record<string, string> = {}): Api {
  const listeners: Array<(s: Settings) => void> = [];
  const api: Api = {
    getAll:       vi.fn(() => Promise.resolve(table)),
    set:          vi.fn((_k: string, _v: string) => Promise.resolve()),
    onChanged:    vi.fn((cb: (s: Settings) => void) => { listeners.push(cb); return () => undefined; }),
    checkLogFile: vi.fn(() => Promise.resolve(true)),
    emit:         s => listeners.forEach(l => l(s)),
  };
  vi.stubGlobal('window', {
    electronAPI: {settings: {getAll: api.getAll, set: api.set, onChanged: api.onChanged}, checkLogFile: api.checkLogFile},
  });
  return api;
}

async function load(table: Record<string, string> = {}) {
  vi.resetModules();
  const api = stubApi(table);
  const {useSettingsStore} = await import('@/state/settingsStore');
  return {api, store: useSettingsStore, get: () => useSettingsStore.getState()};
}

/** The (key, value) of the n-th (default last) settings.set call. */
const written = (api: Api, n = -1): [string, string] => {
  const c = api.set.mock.calls.at(n) as [string, string];
  return [c[0], c[1]];
};

beforeEach(() => {
  changeLanguage.mockClear();
  vi.unstubAllGlobals();
});

describe('settingsStore.init', () => {
  it('loads the parsed table and flips isLoaded', async () => {
    const {get, store} = await load({themeMode: 'dark', carjackLootMs: '7000', lowStockThreshold: '4'});
    expect(get().isLoaded).toBe(false);
    await store.getState().init();
    expect(get()).toMatchObject({isLoaded: true, themeMode: 'dark', lowStockThreshold: 4});
    expect(get().lootWindowMs.carjack).toBe(7000);
  });

  it('is idempotent: calling init twice (or three times) registers ONE onChanged listener', async () => {
    const {api, store} = await load();
    await store.getState().init();
    await store.getState().init();
    await Promise.all([store.getState().init(), store.getState().init()]);
    expect(api.onChanged).toHaveBeenCalledTimes(1);
  });

  it('subscribes BEFORE the table is fetched: an echo arriving mid-load is registered before getAll resolves (pinned order)', async () => {
    const {api, store, get} = await load();
    const pending = store.getState().init();
    expect(api.onChanged).toHaveBeenCalledTimes(1);   // registered synchronously, before getAll resolves
    await pending;
    expect(get().isLoaded).toBe(true);
  });

  it('never calls checkLogFile when checkLogFile is false/omitted', async () => {
    const {api, store} = await load({torchlightPath: 'C:/x'});
    await store.getState().init();
    await store.getState().init({checkLogFile: false});
    expect(api.checkLogFile).not.toHaveBeenCalled();
    expect(store.getState().logFileValid).toBe(false);
  });

  it('checkLogFile true validates the stored path (and an empty path is invalid without a call)', async () => {
    const withPath = await load({torchlightPath: 'C:/x'});
    await withPath.store.getState().init({checkLogFile: true});
    expect(withPath.api.checkLogFile).toHaveBeenCalledWith('C:/x');
    expect(withPath.get().logFileValid).toBe(true);

    const noPath = await load({});
    await noPath.store.getState().init({checkLogFile: true});
    expect(noPath.api.checkLogFile).not.toHaveBeenCalled();
    expect(noPath.get().logFileValid).toBe(false);
  });

  it('a rejected getAll propagates and leaves isLoaded false', async () => {
    const {api, store, get} = await load();
    api.getAll.mockRejectedValueOnce(new Error('ipc down'));
    await expect(store.getState().init()).rejects.toThrow('ipc down');
    expect(get().isLoaded).toBe(false);
  });

  it('a hostile table yields defaults, never throws', async () => {
    const {store, get} = await load({carjackLootMs: 'x', overlayOpacity: 'y', themeMode: '??', lowStockThreshold: '-3'});
    await store.getState().init();
    expect(get()).toMatchObject({
      overlayOpacity: DEFAULT_SETTINGS.overlayOpacity, themeMode: 'system', lowStockThreshold: 0,
    });
    expect(get().lootWindowMs).toEqual(DEFAULT_SETTINGS.lootWindowMs);
  });
});

describe('settingsStore echo (settings:changed)', () => {
  it('replaces the typed state and keeps the runtime fields', async () => {
    const {api, store, get} = await load({torchlightPath: 'C:/x'});
    await store.getState().init({checkLogFile: true});
    api.emit({...parseSettings({}), themeMode: 'light', lowStockThreshold: 9});
    expect(get()).toMatchObject({themeMode: 'light', lowStockThreshold: 9, isLoaded: true, logFileValid: true});
    expect(get().torchlightPath).toBe('');      // the echo carries the WHOLE table, path included
  });

  it('a language change from an echo calls i18n.changeLanguage exactly once', async () => {
    const {api, store} = await load();
    await store.getState().init();
    changeLanguage.mockClear();
    api.emit({...parseSettings({}), language: 'de'});
    expect(changeLanguage).toHaveBeenCalledTimes(1);
    expect(changeLanguage).toHaveBeenCalledWith('de');
    api.emit({...parseSettings({}), language: 'de', themeMode: 'dark'});   // same language again
    expect(changeLanguage).toHaveBeenCalledTimes(1);
  });

  it('a stored non-default language is applied by init (load path)', async () => {
    const {store} = await load({language: 'de'});
    await store.getState().init();
    expect(changeLanguage).toHaveBeenCalledTimes(1);
    expect(changeLanguage).toHaveBeenCalledWith('de');
  });

  it('a local pick followed by its own echo calls changeLanguage once, not twice', async () => {
    const {api, store} = await load();
    await store.getState().init();
    changeLanguage.mockClear();
    store.getState().setLanguage('de');
    api.emit({...parseSettings({}), language: 'de'});
    expect(changeLanguage).toHaveBeenCalledTimes(1);
  });

  it('an echo arriving before init finishes is overwritten by the (newer?) getAll snapshot (pinned ordering)', async () => {
    const {api, store, get} = await load({themeMode: 'dark'});
    const pending = store.getState().init();
    api.emit({...parseSettings({}), themeMode: 'light'});
    await pending;
    expect(get().themeMode).toBe('dark');
  });
});

describe('settingsStore setters', () => {
  it.each([
    ['setTorchlightPath',           'C:/g',    'torchlightPath',           'C:/g'],
    ['setOverlayOpacity',           0.4,       'overlayOpacity',           '0.4'],
    ['setClickThroughWhileRunning', true,      'clickThroughWhileRunning', 'true'],
    ['setClickThroughWhileRunning', false,     'clickThroughWhileRunning', 'false'],
    ['setPauseTotalTimerInTown',    true,      'pauseTotalTimerInTown',    'true'],
    ['setShowEventFeed',            true,      'showEventFeed',            'true'],
    ['setAuctionTaxEnabled',        false,     'auctionTaxEnabled',        'false'],
    ['setLanguage',                 'de',      'language',                 'de'],
    ['setSerperApiKey',             'k-1',     'serper_api_key',           'k-1'],
    ['setRateTimeframe',            'minute',  'rateTimeframe',            'minute'],
    ['setThemeMode',                'dark',    'themeMode',                'dark'],
    ['setLowStockThreshold',        7,         'lowStockThreshold',        '7'],
  ] as const)('%s(%j) writes %s=%s and the optimistic value equals what the echo will carry', async (setter, arg, key, str) => {
    const {api, store, get} = await load();
    await store.getState().init();
    (store.getState()[setter] as (v: unknown) => void)(arg);
    expect(written(api)).toEqual([key, str]);
    const echo = parseSettings({[key]: str});
    const field = Object.entries(get()).find(([, v]) => v === arg)?.[0];
    expect(field).toBeDefined();
    expect((echo as unknown as Record<string, unknown>)[field!]).toEqual(arg);
  });

  it('every setter: the whole optimistic state equals parseSettings of the written row (no drift on echo)', async () => {
    const {api, store, get} = await load();
    await store.getState().init();
    const s = store.getState();
    s.setOverlayOpacity(0.35);
    s.setThemeMode('light');
    s.setLowStockThreshold(5);
    s.setLootWindowMs('carjack', 7000);
    s.setSerperApiKey('abc');
    const table = Object.fromEntries(api.set.mock.calls as Array<[string, string]>);
    const {isLoaded: _l, logFileValid: _v, ...typed} = get();
    const typedKeys = Object.keys(DEFAULT_SETTINGS);
    expect(Object.fromEntries(Object.entries(typed).filter(([k]) => typedKeys.includes(k))))
      .toEqual(parseSettings(table));
  });

  it('setLowStockThreshold(0) is KEPT as 0 and written as "0"', async () => {
    const {api, store, get} = await load({lowStockThreshold: '5'});
    await store.getState().init();
    store.getState().setLowStockThreshold(0);
    expect(get().lowStockThreshold).toBe(0);
    expect(written(api)).toEqual(['lowStockThreshold', '0']);
  });

  it.each([[-1, 0], [-0.5, 0], [2.9, 2], [Number.NaN, 0], [Infinity, 0], [1e21, 1e21]])(
    'setLowStockThreshold(%d) -> optimistic %d, persisted string reads back identically', async (input, expected) => {
      const {api, store, get} = await load();
      await store.getState().init();
      store.getState().setLowStockThreshold(input);
      expect(get().lowStockThreshold).toBe(expected);
      expect(parseSettings({lowStockThreshold: written(api)[1]}).lowStockThreshold).toBe(expected);
    });

  it('setLowStockThreshold(-0) is normalised to +0 both optimistically and persisted', async () => {
    const {api, store, get} = await load();
    await store.getState().init();
    store.getState().setLowStockThreshold(-0);
    expect(written(api)).toEqual(['lowStockThreshold', '0']);
    expect(Object.is(get().lowStockThreshold, 0)).toBe(true);
  });

  it.each(WINDOWED_MECHANICS.map(m => [m.key, m.window.settingKey, m.window.defaultMs] as const))(
    'setLootWindowMs(%s, 4321) writes %s and touches only that row', async (type, key) => {
      const {api, store, get} = await load();
      await store.getState().init();
      const before = {...get().lootWindowMs};
      store.getState().setLootWindowMs(type, 4321);
      expect(written(api)).toEqual([key, '4321']);
      expect(get().lootWindowMs).toEqual({...before, [type]: 4321});
    });

  it('sandlord goes through its own row key sandlordWaveMs', async () => {
    const {api, store} = await load();
    await store.getState().init();
    store.getState().setLootWindowMs('sandlord', 2500);
    expect(written(api)).toEqual(['sandlordWaveMs', '2500']);
  });

  it.each([[Number.NaN], [0], [-1], [0.4], [-0], [Infinity], [-Infinity]])(
    'setLootWindowMs(carjack, %d) falls back to the row default, optimistically AND persisted', async input => {
      const {api, store, get} = await load({carjackLootMs: '7000'});
      await store.getState().init();
      expect(get().lootWindowMs.carjack).toBe(7000);
      store.getState().setLootWindowMs('carjack', input);
      const dflt = MECHANICS.find(m => m.key === 'carjack')!.window!.defaultMs;
      expect(get().lootWindowMs.carjack).toBe(dflt);
      expect(written(api)).toEqual(['carjackLootMs', String(dflt)]);
      expect(parseSettings({carjackLootMs: written(api)[1]}).lootWindowMs.carjack).toBe(dflt);
    });

  it('setLootWindowMs(1.9) floors to 1, and a huge value in exponent form round-trips', async () => {
    const {api, store, get} = await load();
    await store.getState().init();
    store.getState().setLootWindowMs('hunting', 1.9);
    expect(get().lootWindowMs.hunting).toBe(1);
    expect(written(api)).toEqual(['huntingLootMs', '1']);
    store.getState().setLootWindowMs('hunting', 1e21);
    // String(1e21) is '1e+21' and Number('1e+21') parses: optimistic == echo
    expect(written(api)).toEqual(['huntingLootMs', '1e+21']);
    expect(get().lootWindowMs.hunting).toBe(parseSettings({huntingLootMs: '1e+21'}).lootWindowMs.hunting);
  });

  it('rapid successive window writes keep the other rows (no lost update through the spread)', async () => {
    const {store, get} = await load();
    await store.getState().init();
    const types: WindowedSeasonalType[] = WINDOWED_MECHANICS.map(m => m.key);
    types.forEach((t, i) => store.getState().setLootWindowMs(t, 1000 + i));
    types.forEach((t, i) => expect(get().lootWindowMs[t]).toBe(1000 + i));
  });

  it('setLootWindowMs creates a new lootWindowMs object (never mutates the previous / DEFAULT_SETTINGS)', async () => {
    const {store, get} = await load();
    await store.getState().init();
    const before = get().lootWindowMs;
    const snapshot = JSON.stringify(before);
    store.getState().setLootWindowMs('carjack', 1234);
    expect(get().lootWindowMs).not.toBe(before);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(DEFAULT_SETTINGS.lootWindowMs.carjack).toBe(5000);
  });

  it('a rejected settings.set is swallowed (logged), and the optimistic value stays (pinned: no rollback)', async () => {
    const {api, store, get} = await load();
    await store.getState().init();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.set.mockRejectedValueOnce(new Error('persist failed'));
    expect(() => store.getState().setThemeMode('dark')).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
    expect(err).toHaveBeenCalled();
    expect(get().themeMode).toBe('dark');   // FINDING: UI keeps a value the DB never got
    err.mockRestore();
  });

  it('setLanguage("") writes "" and sends i18n an empty language (pinned: parseSettings keeps "")', async () => {
    const {api, store, get} = await load();
    await store.getState().init();
    changeLanguage.mockClear();
    store.getState().setLanguage('');
    expect(written(api)).toEqual(['language', '']);
    expect(get().language).toBe('');
    expect(changeLanguage).toHaveBeenCalledWith('');
  });

  it('setOverlayOpacity does not clamp optimistically (pinned): an out-of-range value drifts from the echo', async () => {
    const {api, store, get} = await load();
    await store.getState().init();
    store.getState().setOverlayOpacity(5);
    expect(written(api)).toEqual(['overlayOpacity', '5']);
    expect(get().overlayOpacity).toBe(5);
    expect(parseSettings({overlayOpacity: '5'}).overlayOpacity).toBe(1);   // the echo will clamp to 1
  });
});
