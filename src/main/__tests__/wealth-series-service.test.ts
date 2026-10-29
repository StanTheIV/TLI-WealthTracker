/**
 * Step 4.5b service seams.
 *  - TrackingService: `wealth_recorded` carries `point {id, ts, value}`.
 *  - `wealth:changed` (no payload) trigger matrix: the broadcast the owner
 *    already holds — SettingsService's `broadcast` and the db IPC handlers'
 *    `deps.broadcast` — emits channel 'wealth:changed'. The handlers are
 *    exercised through `registerDbHandlers` with `electron` mocked, over a
 *    real migrated DB and a real WealthSeries (whose cache they keep coherent).
 */
import {describe, it, expect, beforeEach, afterEach, vi, type Mock} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import {SettingsService} from '@/main/settings-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import {Engine} from '@/main/engine/engine';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import {WealthRecorder} from '@/main/wealth-recorder';
import {WealthSeries} from '@/main/wealth-series';
import {registerDbHandlers} from '@/main/ipc/db';
import type {RawEvent} from '@/worker/processors/types';
import type {StoredWealthDatapoint} from '@/shared/contracts/db';
import type {WealthSeriesPoint} from '@/shared/contracts/wealth';
import {engineEvents, type Sent} from '@/test/broadcast';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import {TOWN, MAP} from '@/main/engine/__tests__/seasonal-fixtures';
import {
  initDb, wealthInsert, wealthGetRange, wealthGetRangeHeads, wealthGetLatest, itemsGetAll, itemsImportBatch,
  filtersGetAll, settingsGetAll, settingsSet,
} from '@/main/db';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }},
}));

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const NOW        = new Date('2026-03-01T12:00:00Z').getTime();
const ITEM_BAG   = 100;

// -- TrackingService harness -------------------------------------------------

function buildTracking(opts: {
  wealthRecorder: TrackingDeps['wealthRecorder'];
  wealthSeries:   TrackingDeps['wealthSeries'];
  items?:         TrackingDeps['items']['getAll'];
}) {
  const conn = openMigratedNodeSqlite();
  const sent: Sent[] = [];
  const worker = {start: vi.fn(), stop: vi.fn()};
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const engines: Engine[] = [];
  const deps: TrackingDeps = {
    createEngine:   emit => { const e = createProductionEngine(emit); engines.push(e); return e; },
    store:          new SqliteSessionStore(conn),
    broadcast:      (channel, payload) => { sent.push({channel, payload}); },
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => ({torchlightPath: TORCHLIGHT})},
    filters:        {getAll: () => []},
    items: {
      getAll:             opts.items ?? (() => []),
      getLocked:          () => false,
      insertIfMissing:    () => true,
      recordScrapedPrice: () => ({priceDate: NOW}),
    },
    wealthRecorder: opts.wealthRecorder,
    wealthSeries:   opts.wealthSeries,
    log:            {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
  };
  const service = new TrackingService(deps);
  const raw = (e: RawEvent) => onEvent!(e);
  return {service, sent, raw, engines};
}

function init(raw: (e: RawEvent) => void): void {
  raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: ITEM_BAG, quantity: 5});
  raw({type: 'bag_snapshot_start'});
}
function runMap(raw: (e: RawEvent) => void): void {
  raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
  raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 3});
  vi.advanceTimersByTime(60_000);
  raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
}
const wealthEvents = (sent: Sent[]) =>
  engineEvents(sent).flatMap(e => e.type === 'wealth_recorded' ? [e] : []);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); handlers.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe('wealth_recorded carries the displayed point', () => {
  it('point {id, ts, value} comes from wealthSeries.pointOf(the row the recorder returned)', () => {
    const rows: StoredWealthDatapoint[] = [
      {id: 41, timestamp: NOW,          value: 130, breakdown: '{}'},
      {id: 42, timestamp: NOW + 60_000, value: 140, breakdown: '{}'},
    ];
    let n = 0;
    const snapshot: Mock<(engine: Engine) => StoredWealthDatapoint> = vi.fn(() => rows[n++]);
    const pointOf = vi.fn((row: StoredWealthDatapoint): WealthSeriesPoint => ({id: row.id, ts: row.timestamp, value: row.value - 1}));
    const h = buildTracking({wealthRecorder: {snapshot}, wealthSeries: {pointOf}});
    h.service.start();
    init(h.raw);
    runMap(h.raw);
    const evs = wealthEvents(h.sent);
    expect(evs).toHaveLength(2);
    expect(pointOf.mock.calls.map(c => c[0])).toEqual(rows);
    expect(evs[0].point).toEqual({id: 41, ts: NOW,          value: 129});
    expect(evs[1].point).toEqual({id: 42, ts: NOW + 60_000, value: 139});
  });

  it('with the real recorder + series + DB the event\'s point equals the next series() last point', () => {
    initDb(openNodeSqlite(), {backup: () => { throw new Error('no backup'); }});
    itemsImportBatch([{id: String(ITEM_BAG), name: 'Ember', type: 'Remembrance Material', price: 10, priceDate: 1}]);
    const log = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
    const series = realSeries();
    const recorder = new WealthRecorder({items: {getAll: itemsGetAll}, insert: wealthInsert, log});
    const h = buildTracking({wealthRecorder: recorder, wealthSeries: series, items: itemsGetAll});
    h.service.start();
    init(h.raw);
    const evs = wealthEvents(h.sent);
    expect(evs).toHaveLength(1);
    expect(evs[0].point.ts).toBe(NOW);
    expect(evs[0].point.id).toBeGreaterThan(0);
    const last = series.series(0, NOW + 1_000_000).at(-1);
    expect(evs[0].point).toEqual(last);
    expect(last!.value).toBeCloseTo(5 * 10 * 0.85, 9); // tax defaults ON
  });
});

/** A WealthSeries over the db.ts module connection. */
function realSeries(): WealthSeries {
  return new WealthSeries({
    points:   {heads: wealthGetRangeHeads, range: wealthGetRange, latest: wealthGetLatest},
    items:    {getAll: itemsGetAll},
    filters:  {getAll: filtersGetAll},
    settings: {getAll: settingsGetAll},
  });
}

// -- wealth:changed ----------------------------------------------------------

function changedCount(sent: Sent[]): number {
  return sent.filter(s => s.channel === 'wealth:changed').length;
}

describe('wealth:changed — SettingsService', () => {
  function build() {
    const sent: Sent[] = [];
    const table = new Map<string, string>();
    const service = new SettingsService({
      store: {set: (k, v) => { table.set(k, v); }, getAll: () => Object.fromEntries(table)},
      broadcast: (channel, payload) => { sent.push({channel, payload}); },
      tracking:  {reconfigure: () => {}},
      log:       {reloadConfig: () => {}, error: () => {}},
    });
    return {service, sent, table};
  }

  it('fires for auctionTaxEnabled, with no payload, after the value is persisted', () => {
    const h = build();
    h.service.set('auctionTaxEnabled', 'false');
    expect(changedCount(h.sent)).toBe(1);
    const evt = h.sent.find(s => s.channel === 'wealth:changed')!;
    expect(evt.payload).toBeUndefined();
    expect(h.table.get('auctionTaxEnabled')).toBe('false');
    h.service.set('auctionTaxEnabled', 'true');
    expect(changedCount(h.sent)).toBe(2);
  });

  it.each([
    ['language', 'de'], ['overlayOpacity', '0.5'], ['themeMode', 'dark'], ['lowStockThreshold', '3'],
    ['carjackLootMs', '7000'], ['logging.level', 'debug'], ['wealthChartRange', '7d'], ['showEventFeed', 'true'],
  ])('does NOT fire for unrelated setting %s', (key, value) => {
    const h = build();
    h.service.set(key, value);
    expect(changedCount(h.sent)).toBe(0);
    expect(h.sent.some(s => s.channel === 'settings:changed')).toBe(true);
  });
});

describe('wealth:changed — db IPC handlers', () => {
  let sent: Sent[];
  let tracking: {isTracking: Mock<() => boolean>; deleteSession: Mock<(id: string) => void>};
  let series: WealthSeries;

  function register(): void {
    const conn = openNodeSqlite();
    initDb(conn, {backup: () => { throw new Error('no backup'); }});
    itemsImportBatch([{id: '100', name: 'Ember', type: 'Remembrance Material', price: 10, priceDate: 1}]);
    sent = [];
    tracking = {isTracking: vi.fn(() => false), deleteSession: vi.fn()};
    series = realSeries();
    registerDbHandlers({
      broadcast:    (channel: string, payload?: unknown) => { sent.push({channel, payload}); },
      sessions:     new SqliteSessionStore(conn),
      tracking,
      wealthSeries: series,
      onFiltersChanged: () => undefined,
      serperKey:    {get: async () => 'k'},
    });
  }
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  const filter = (over: object = {}) => ({id: 'f1', name: 'F', enabled: true, rules: [], ...over});

  beforeEach(register);

  it('fires once for each active-filter write: insert, update, set-enabled, delete', async () => {
    for (const [channel, args] of [
      ['db:filters:insert',      [filter()]],
      ['db:filters:update',      [filter({name: 'G'})]],
      ['db:filters:set-enabled', ['f1', false]],
      ['db:filters:delete',      ['f1']],
    ] as const) {
      const before = changedCount(sent);
      await call(channel, ...args);
      expect(changedCount(sent), channel).toBe(before + 1);
    }
  });

  it('fires once for an item type change', async () => {
    await call('db:items:set-type', '100', 'Compass');
    expect(changedCount(sent)).toBe(1);
  });

  it('fires once for deleting a point and once for clearing all data', async () => {
    wealthInsert({timestamp: 1, value: 1, breakdown: '{}'});
    const id = wealthGetLatest(1)[0].id!;
    await call('db:wealth:delete', id);
    expect(changedCount(sent)).toBe(1);
    await call('db:wealth:clear');
    expect(changedCount(sent)).toBe(2);
  });

  it('a refused clear (tracking) does not fire', async () => {
    tracking.isTracking.mockReturnValue(true);
    await expect(Promise.resolve().then(() => call('db:wealth:clear'))).rejects.toThrow();
    expect(changedCount(sent)).toBe(0);
  });

  it('does NOT fire for reads, names, locks or price updates', async () => {
    await call('db:filters:get-all');
    await call('db:items:get-all');
    await call('db:items:set-name', '100', 'New');
    await call('db:items:set-locked', '100', true);
    await call('db:items:set-price', '100', 12);
    expect(changedCount(sent)).toBe(0);
    expect(sent.filter(s => s.channel === 'items:changed').length).toBeGreaterThan(0);
  });

  it('registers the new read channels', () => {
    expect(handlers.has('db:wealth:series')).toBe(true);
    expect(handlers.has('db:wealth:latest-breakdown')).toBe(true);
  });

  it('the read channels return the series\' values', async () => {
    const id = wealthInsert({timestamp: 5, value: 20, breakdown: '{"100":{"qty":2,"price":10,"total":20}}'});
    settingsSet('auctionTaxEnabled', 'false');
    expect(await call('db:wealth:series', 0, 10)).toEqual([{id, ts: 5, value: 20}]);
    expect(await call('db:wealth:latest-breakdown')).toEqual(
      {id, ts: 5, value: 20, rows: [{id: '100', qty: 2, unitPrice: 10, total: 20}]});
  });

  it('delete forgets exactly the deleted point; clear drops every cached point', async () => {
    const a = wealthInsert({timestamp: 1, value: 1, breakdown: '{}'});
    wealthInsert({timestamp: 2, value: 2, breakdown: '{}'});
    wealthInsert({timestamp: 3, value: 3, breakdown: '{}'});
    await call('db:wealth:series', 0, 10);
    expect(series.cachedCount).toBe(3);
    await call('db:wealth:delete', a);
    expect(series.cachedCount).toBe(2);
    expect((await call('db:wealth:series', 0, 10) as WealthSeriesPoint[]).map(p => p.ts)).toEqual([2, 3]);
    await call('db:wealth:clear');
    expect(series.cachedCount).toBe(0);
    expect(await call('db:wealth:series', 0, 10)).toEqual([]);
  });

  it('a refused clear keeps the cache (nothing was deleted)', async () => {
    wealthInsert({timestamp: 1, value: 1, breakdown: '{}'});
    await call('db:wealth:series', 0, 10);
    tracking.isTracking.mockReturnValue(true);
    await expect(Promise.resolve().then(() => call('db:wealth:clear'))).rejects.toThrow();
    expect(series.cachedCount).toBe(1);
  });

  it('fires once for an import that inserted rows, never for one that inserted none', async () => {
    await call('db:items:import-batch', [{id: '100', name: 'Dup', type: 'Compass', price: 1, priceDate: 1}]);
    expect(changedCount(sent)).toBe(0);
    await call('db:items:import-batch', [
      {id: '700', name: 'A', type: 'Compass', price: 1, priceDate: 1},
      {id: '701', name: 'B', type: 'Compass', price: 1, priceDate: 1},
    ]);
    expect(changedCount(sent)).toBe(1);
  });

  describe('lookup-name', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    function stubLookup(tag: string): void {
      const search = {organic: [{title: 'Thing', link: 'https://tlidb.com/Some_Thing', snippet: 'ID: 100'}]};
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('serper')
        ? new Response(JSON.stringify(search))
        : new Response(`<span class="tag tlborder">${tag}</span>`)));
    }

    it('fires once when the lookup writes a type', async () => {
      stubLookup('Compass');
      await call('db:items:lookup-name', '100');
      expect(itemsGetAll().find(i => i.id === '100')?.type).toBe('compass');
      expect(changedCount(sent)).toBe(1);
    });

    it('does not fire when it writes only a name', async () => {
      stubLookup('Unknown Tag'); // → 'other', which is never written
      await call('db:items:lookup-name', '100');
      expect(itemsGetAll().find(i => i.id === '100')?.name).toBe('Some Thing');
      expect(changedCount(sent)).toBe(0);
    });
  });
});
