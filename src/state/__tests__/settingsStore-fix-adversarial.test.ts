/**
 * 3.2 adversarial, round 2: F2 (rejected write re-syncs) races and F3/F4 (the
 * optimistic value is exactly what the echo carries; the written string is a
 * fixed point of the parser). Same Node harness as settingsStore.test.ts.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {WINDOWED_MECHANICS, type WindowedSeasonalType} from '@/shared/mechanics';
import {DEFAULT_SETTINGS, SETTING_KEYS, parseSettings, type Settings} from '@/shared/settings';

const changeLanguage = vi.fn((_lng: string) => Promise.resolve());
vi.mock('@/i18n', () => ({default: {changeLanguage: (lng: string) => changeLanguage(lng)}}));

function stubApi(table: Record<string, string>) {
  const listeners: Array<(s: Settings) => void> = [];
  const api = {
    getAll:       vi.fn(() => Promise.resolve({...table})),
    set:          vi.fn((_k: string, _v: string) => Promise.resolve()),
    onChanged:    vi.fn((cb: (s: Settings) => void) => { listeners.push(cb); return () => undefined; }),
    checkLogFile: vi.fn(() => Promise.resolve(true)),
    emit:         (s: Settings) => listeners.forEach(l => l(s)),
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
  return {api, table, store: useSettingsStore, get: () => useSettingsStore.getState()};
}

type Loaded = Awaited<ReturnType<typeof load>>;
type Actions = ReturnType<Loaded['get']>;

const typed = (s: object) =>
  Object.fromEntries(Object.entries(s).filter(([k]) => k in DEFAULT_SETTINGS));

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => {
  changeLanguage.mockClear();
  vi.unstubAllGlobals();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('F2: a rejected write followed by another write', () => {
  it('a rejected set then a successful set of another field: after both settle and the echo lands, the store equals the table', async () => {
    const {api, table, store, get} = await load({themeMode: 'light'});
    await store.getState().init();
    api.set.mockImplementationOnce(() => Promise.reject(new Error('nope')));
    api.set.mockImplementationOnce((k: string, v: string) => { table[k] = v; return Promise.resolve(); });
    store.getState().setThemeMode('dark');           // rejected
    store.getState().setRateTimeframe('minute');     // committed
    await flush();
    api.emit(parseSettings(table));                  // B's echo
    await flush();
    expect(get().themeMode).toBe('light');
    expect(get().rateTimeframe).toBe('minute');
    expect(typed(get())).toEqual(parseSettings(table));
  });

  it('a re-sync that ran before the second write reached main: the second write is held by its own echo', async () => {
    const {api, table, store, get} = await load();
    await store.getState().init();
    api.set.mockImplementationOnce(() => Promise.reject(new Error('nope')));
    store.getState().setThemeMode('dark');
    await flush();                                    // re-sync done: table is empty
    expect(get().themeMode).toBe('system');
    store.getState().setRateTimeframe('minute');     // optimistic
    table['rateTimeframe'] = 'minute';
    api.emit(parseSettings(table));
    expect(get().rateTimeframe).toBe('minute');
  });

  it('a rejected set never touches logFileValid / isLoaded, even when the re-sync changes the path', async () => {
    const {api, store, get} = await load({torchlightPath: 'C:/a'});
    await store.getState().init({checkLogFile: true});
    expect(get().logFileValid).toBe(true);
    api.set.mockImplementationOnce(() => Promise.reject(new Error('nope')));
    store.getState().setTorchlightPath('C:/b');
    await flush();
    expect(get().torchlightPath).toBe('C:/a');
    expect(get()).toMatchObject({logFileValid: true, isLoaded: true});
  });

  it('a rejected setLootWindowMs restores that row from the table', async () => {
    const {api, store, get} = await load({carjackLootMs: '7000'});
    await store.getState().init();
    api.set.mockImplementationOnce(() => Promise.reject(new Error('nope')));
    store.getState().setLootWindowMs('carjack', 99);
    expect(get().lootWindowMs.carjack).toBe(99);
    await flush();
    expect(get().lootWindowMs.carjack).toBe(7000);
  });

  it('a rejected setLanguage reverts i18n to the stored language (store and i18n never diverge)', async () => {
    const {api, store, get} = await load({language: 'en'});
    await store.getState().init();
    changeLanguage.mockClear();
    api.set.mockImplementationOnce(() => Promise.reject(new Error('nope')));
    store.getState().setLanguage('de');
    await flush();
    expect(get().language).toBe('en');
    expect(changeLanguage.mock.calls.map(c => c[0])).toEqual(['de', 'en']);
  });

  it('two rejections in a row converge on the table', async () => {
    const {api, store, get} = await load({themeMode: 'light', rateTimeframe: 'minute'});
    await store.getState().init();
    api.set.mockImplementation(() => Promise.reject(new Error('nope')));
    store.getState().setThemeMode('dark');
    store.getState().setRateTimeframe('hour');
    await flush();
    expect(get()).toMatchObject({themeMode: 'light', rateTimeframe: 'minute'});
  });

  it('a synchronously throwing settings.set surfaces to the caller (pinned: not routed to the re-sync)', async () => {
    const {api, store} = await load();
    await store.getState().init();
    api.set.mockImplementationOnce(() => { throw new Error('sync'); });
    expect(() => store.getState().setThemeMode('dark')).toThrow('sync');
  });
});

describe('F3: optimistic === parse(written) === echo, and the written string is a fixed point', () => {
  const NUMS = [NaN, Infinity, -Infinity, -0, 0, 0.5, -1, 1.9, 5, 1e21, 1e300, Number.MAX_VALUE, Number.MIN_VALUE, 1e-7, 123456789.987];
  const STRS = ['', ' ', '\t', '\u00a0', 'abc', '0x10', '5e3', 'Infinity', '__proto__', 'x'.repeat(10_000)];

  /** Run one setter; the store must equal parse(written row), and rewriting that row is a no-op. */
  async function check(call: (s: Actions) => void): Promise<{key: string; value: string; state: Loaded['get']}> {
    const {api, store, get} = await load();
    await store.getState().init();
    call(store.getState());
    const [key, value] = api.set.mock.calls.at(-1) as [string, string];
    const parsed = parseSettings({[key]: value});
    expect(typed(get())).toEqual(parsed);                       // optimistic === what the echo carries
    const reparsed = parseSettings({[key]: value});
    expect(reparsed).toEqual(parsed);
    return {key, value, state: get};
  }

  it.each(NUMS)('setOverlayOpacity(%s): in [0,1], never -0, fixed point', async n => {
    const {state, value} = await check(s => s.setOverlayOpacity(n));
    const o = state().overlayOpacity;
    expect(o).toBeGreaterThanOrEqual(0);
    expect(o).toBeLessThanOrEqual(1);
    expect(Object.is(o, -0)).toBe(false);
    expect(value).toBe(String(o));
    expect(parseSettings({overlayOpacity: String(o)}).overlayOpacity).toBe(o);
  });

  it.each(NUMS)('setLowStockThreshold(%s): non-negative int, never -0, fixed point', async n => {
    const {state, value} = await check(s => s.setLowStockThreshold(n));
    const v = state().lowStockThreshold;
    expect(Number.isInteger(v)).toBe(true);
    expect(Object.is(v, -0)).toBe(false);
    expect(value).toBe(String(v));
    expect(parseSettings({lowStockThreshold: value}).lowStockThreshold).toBe(v);
  });

  const WIN_CASES: Array<[WindowedSeasonalType, number]> =
    WINDOWED_MECHANICS.flatMap(m => NUMS.map(n => [m.key, n] as [WindowedSeasonalType, number]));
  it.each(WIN_CASES)('setLootWindowMs(%s, %s): >= 1, written as its own setting key, fixed point', async (type, n) => {
    const {state, key, value} = await check(s => s.setLootWindowMs(type, n));
    const v = state().lootWindowMs[type];
    expect(v).toBeGreaterThanOrEqual(1);
    expect(key).toBe(WINDOWED_MECHANICS.find(m => m.key === type)!.window.settingKey);
    expect(value).toBe(String(v));
    expect(parseSettings({[key]: value}).lootWindowMs[type]).toBe(v);
  });

  it.each(STRS)('string setters carry %j verbatim', async v => {
    await check(s => s.setTorchlightPath(v));
    const {state} = await check(s => s.setLanguage(v));
    expect(state().language).toBe(v);
  });

  it.each(['', 'HOUR', ' hour', 'week', '__proto__', 'minute'])('setRateTimeframe(%j) cast garbage never reaches state', async g => {
    const {state} = await check(s => s.setRateTimeframe(g as never));
    expect(['hour', 'minute']).toContain(state().rateTimeframe);
  });

  it.each(['', 'Dark', 'auto', 'light', null, undefined, 0])('setThemeMode(%j) cast garbage never reaches state', async g => {
    const {state} = await check(s => s.setThemeMode(g as never));
    expect(['system', 'dark', 'light']).toContain(state().themeMode);
  });

  it.each([true, false, 1, 0, 'true', 'false', '', null, undefined, NaN])('boolean setters given %j (cast): optimistic equals echo', async g => {
    await check(s => s.setClickThroughWhileRunning(g as never));
    await check(s => s.setPauseTotalTimerInTown(g as never));
    await check(s => s.setShowEventFeed(g as never));
    await check(s => s.setAuctionTaxEnabled(g as never));
  });

  it('SETTING_KEYS covers every non-window field (no setter without a key)', () => {
    expect(Object.keys(SETTING_KEYS).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'lootWindowMs').sort());
  });
});

describe('F4: blank opacity variants read as missing (0.9), never 0', () => {
  it.each(['\t', '\n', '\u00a0', '\u2003', '\u2028', '\ufeff', ' \u00a0\u2003 '])('%j -> default', v => {
    expect(parseSettings({overlayOpacity: v}).overlayOpacity).toBe(0.9);
  });

  it.each(['\u200b', '\u0000'])('invisible non-whitespace %j is not blank and not a number: default', v => {
    expect(parseSettings({overlayOpacity: v}).overlayOpacity).toBe(0.9);
  });

  it('numbers padded with unicode whitespace still parse', () => {
    expect(parseSettings({overlayOpacity: '\u00a00.3\u2003'}).overlayOpacity).toBe(0.3);
  });

  it('an explicit "0" is a real 0, distinct from blank', () => {
    expect(parseSettings({overlayOpacity: '0'}).overlayOpacity).toBe(0);
  });

  it.each(['\t', '\u00a0', '\u2003'])('blank windows %j -> each default; blank lowStock -> 0', v => {
    const raw = Object.fromEntries(WINDOWED_MECHANICS.map(m => [m.window.settingKey, v]));
    expect(parseSettings({...raw, lowStockThreshold: v}).lootWindowMs).toEqual(DEFAULT_SETTINGS.lootWindowMs);
    expect(parseSettings({lowStockThreshold: v}).lowStockThreshold).toBe(0);
  });
});
