/**
 * Tests for TrackingService: the run lifecycle over a real engine + real
 * SqliteSessionStore (node:sqlite), with the worker, broadcast, items,
 * settings, filters, wealth recorder and logger faked. Raw events enter
 * through the fake worker's captured onEvent, exactly like the log reader.
 */
import {describe, it, expect, beforeEach, afterEach, vi, type Mock} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import type {Broadcast} from '@/main/broadcast';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {Engine} from '@/main/engine/engine';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {DbItemFilter, DbSession} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
import {LOG_SUBPATH} from '@/shared/paths';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {TOWN, MAP} from '@/main/engine/__tests__/seasonal-fixtures';

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const LOG_PATH   = `${TORCHLIGHT}/${LOG_SUBPATH}`;
const NOW        = new Date('2026-03-01T12:00:00Z').getTime();

const ITEM_BAG   = 100; // in the bag at init
const ITEM_LOOT  = 200; // picked up in a map
const ITEM_LOOT2 = 201; // picked up in a later map

interface Sent {channel: string; payload: unknown}

interface Harness {
  service: TrackingService;
  store:   SqliteSessionStore;
  sent:    Sent[];
  worker:  {start: Mock<(logPath: string) => void>; stop: Mock<() => void>};
  /** The fake worker's onEvent — feeds raw events into the service. */
  raw:     (event: RawEvent) => void;
  items: {
    getAll:             Mock<() => ReturnType<TrackingDeps['items']['getAll']>>;
    getLocked:          Mock<(id: string) => boolean>;
    insertIfMissing:    Mock<(id: string) => boolean>;
    recordScrapedPrice: Mock<TrackingDeps['items']['recordScrapedPrice']>;
  };
  settings: Record<string, string>;
  filters:  DbItemFilter[];
  wealth:   {snapshot: Mock<(engine: Engine, sessionId: string | null) => void>};
  log:      {debug: Mock; info: Mock; warn: Mock; error: Mock};
  /** Every engine the service created, in order. */
  engines:  Engine[];
}

function build(opts: {settings?: Record<string, string>; broadcast?: (sent: Sent[]) => Broadcast} = {}): Harness {
  const store   = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: Sent[] = [];
  const engines: Engine[] = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const worker  = {start: vi.fn<(logPath: string) => void>(), stop: vi.fn<() => void>()};
  const items   = {
    getAll:             vi.fn(() => [] as ReturnType<TrackingDeps['items']['getAll']>),
    getLocked:          vi.fn((_id: string) => false),
    insertIfMissing:    vi.fn((_id: string) => true),
    recordScrapedPrice: vi.fn<TrackingDeps['items']['recordScrapedPrice']>(() => ({priceDate: NOW})),
  };
  const settings = opts.settings ?? {torchlightPath: TORCHLIGHT};
  const filters: DbItemFilter[] = [];
  const wealth  = {snapshot: vi.fn<(engine: Engine, sessionId: string | null) => void>()};
  const log     = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const broadcast: Broadcast = opts.broadcast?.(sent) ?? ((channel, payload) => { sent.push({channel, payload}); });

  const service = new TrackingService({
    createEngine:   emit => { const e = createProductionEngine(emit); engines.push(e); return e; },
    store,
    broadcast,
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => settings},
    filters:        {getAll: () => filters},
    items,
    wealthRecorder: wealth,
    log,
  });

  const raw = (event: RawEvent) => {
    if (!onEvent) throw new Error('createWorker not called');
    onEvent(event);
  };
  return {service, store, sent, worker, raw, items, settings, filters, wealth, log, engines};
}

// -- raw-event drivers -------------------------------------------------------

/** One-slot bag dump closed by a snapshot marker → immediate init. */
function init(h: Harness): void {
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: ITEM_BAG, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});
}

/** Town → map, pick up `qty` of `itemId`, map → town. */
function runMap(h: Harness, itemId = ITEM_LOOT, qty = 3, slotId = 2): void {
  h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
  h.raw({type: 'bag_update', pageId: 0, slotId, itemId, quantity: qty});
  vi.advanceTimersByTime(60_000);
  h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
}

// -- broadcast readers -------------------------------------------------------

const events = (h: Harness): EngineEvent[] =>
  h.sent.filter(s => s.channel === 'engine:event').map(s => s.payload as EngineEvent);

const types = (h: Harness): string[] => events(h).map(e => e.type);

const savedIds = (h: Harness): string[] =>
  events(h).flatMap(e => (e.type === 'session_saved' ? [e.sessionId] : []));

const sessionFinishedIndex = (h: Harness): number =>
  events(h).findIndex(e => e.type === 'tracker_finished' && e.tracker.kind === 'session');

/** The id from the last `log.info(<feature>, '<prefix>id=…')` call. */
function loggedId(h: Harness, prefix: string): string {
  const calls = h.log.info.mock.calls.filter(([, msg]) => typeof msg === 'string' && msg.startsWith(prefix));
  const msg = calls.at(-1)?.[1] as string | undefined;
  const id = msg?.match(/id=([^,\s]+)/)?.[1];
  if (!id) throw new Error(`no log line starting "${prefix}"`);
  return id;
}

function savedSession(over: Partial<DbSession> = {}): DbSession {
  return {
    id:            'old',
    name:          'My run',
    savedAt:       '2026-02-01T10:00:00.000Z',
    totalTime:     120,
    mapTime:       100,
    mapCount:      2,
    drops:         {'300': 4},
    dropsBySource: {},
    attribution:   'drop-through',
    priceSnapshot: {},
    spent:         {},
    ...over,
  };
}

function oldRows() {
  return [1, 2].map(mapIndex => ({
    sessionId: 'old', mapIndex, startedAt: 1_000 * mapIndex, duration: 50_000,
    drops: {'300': 2}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('TrackingService — full run', () => {
  it('start → init → map → town → stop saves the session; broadcasts in order', () => {
    const h = build();
    h.service.start();
    expect(h.worker.start).toHaveBeenCalledWith(LOG_PATH);

    init(h);
    runMap(h);
    h.service.stop();

    const [id] = savedIds(h);
    expect(savedIds(h)).toHaveLength(1);
    expect(id).toBe(loggedId(h, 'Session created: '));

    const session = h.store.getSession(id);
    expect(session).toMatchObject({drops: {[ITEM_LOOT]: 3}, mapCount: 1, attribution: 'drop-through'});
    expect(h.store.getRows(id)).toMatchObject([{mapIndex: 1, drops: {[ITEM_LOOT]: 3}, parentMapIndex: null}]);

    const t = types(h);
    for (const type of ['init_started', 'init_complete', 'wealth_recorded', 'map_ended']) expect(t).toContain(type);
    expect(t.indexOf('init_started')).toBeLessThan(t.indexOf('init_complete'));
    expect(t.indexOf('init_complete')).toBeLessThan(t.indexOf('wealth_recorded'));
    // session_saved goes out BEFORE the session tracker_finished that caused it.
    expect(t.indexOf('session_saved')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('session_saved')).toBeLessThan(sessionFinishedIndex(h));

    // Wealth: init_complete + map_ended, each with the live engine and session id.
    expect(h.wealth.snapshot).toHaveBeenCalledTimes(2);
    for (const [engine, sessionId] of h.wealth.snapshot.mock.calls) {
      expect(engine).toBe(h.engines[0]);
      expect(sessionId).toBe(id);
    }
    expect(t.filter(x => x === 'wealth_recorded')).toHaveLength(2);
  });

  it('configures the engine after start (filter + item types survive ctx.reset)', () => {
    const h = build();
    h.filters.push({id: 'f1', name: 'Mine', enabled: true, rules: '[]'});
    h.service.start();
    expect(h.engines[0].getFilter()).not.toBeNull();
    expect(h.log.info).toHaveBeenCalledWith('filter', 'Filter set: "Mine"');
    expect(h.log.info).toHaveBeenCalledWith('engine', 'Engine started');
  });
});

describe('TrackingService — continue', () => {
  it('keeps the name, adds old totals, appends rows with mapIndex restarting at 1 (characterization)', () => {
    const h = build();
    h.store.insertSession(savedSession());
    h.store.insertRows(oldRows());

    h.service.continueSession('old');
    init(h);
    runMap(h);
    h.service.stop();

    expect(savedIds(h)).toEqual(['old']);
    expect(h.store.listSessions()).toHaveLength(1);
    const session = h.store.getSession('old')!;
    expect(session.name).toBe('My run');
    expect(session.drops).toEqual({'300': 4, [ITEM_LOOT]: 3});
    expect(session.mapCount).toBe(3);
    expect(session.totalTime).toBeGreaterThanOrEqual(120);
    // 2.1 flips this: the appended row reuses mapIndex 1.
    expect(h.store.getRows('old').map(r => r.mapIndex)).toEqual([1, 2, 1]);
  });

  it('an unknown id silently starts a fresh session (characterization)', () => {
    const h = build();
    h.service.continueSession('nope');
    init(h);
    runMap(h);
    h.service.stop();

    const [id] = savedIds(h);
    expect(id).not.toBe('nope');
    expect(h.store.getSession('nope')).toBeNull();
    expect(h.store.listSessions().map(s => s.id)).toEqual([id]);
    expect(h.log.info).toHaveBeenCalledWith('session', `Session created: id=${id}`);
  });
});

describe('TrackingService — reset', () => {
  it('saves under a NEW id with only post-reset drops', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h, ITEM_LOOT, 3);
    const firstId = loggedId(h, 'Session created: ');

    h.service.reset();
    const resetId = loggedId(h, 'Session reset; new ');
    expect(resetId).not.toBe(firstId);

    runMap(h, ITEM_LOOT2, 2, 3);
    h.service.stop();

    expect(savedIds(h)).toEqual([resetId]);
    expect(h.store.getSession(firstId)).toBeNull();
    expect(h.store.getSession(resetId)!.drops).toEqual({[ITEM_LOOT2]: 2});
    expect(h.store.getRows(resetId)).toMatchObject([{mapIndex: 1, drops: {[ITEM_LOOT2]: 2}}]);
  });

  it('is a no-op without an engine', () => {
    const h = build();
    expect(() => h.service.reset()).not.toThrow();
    expect(h.sent).toEqual([]);
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it('during initializing still replaces the session id — a continued run then inserts a new row (characterization)', () => {
    const h = build();
    h.store.insertSession(savedSession());

    h.service.continueSession('old');
    h.service.reset(); // engine.reset() no-ops while initializing; persistence is replaced anyway
    const resetId = loggedId(h, 'Session reset; new ');

    init(h);
    runMap(h);
    h.service.stop();

    expect(savedIds(h)).toEqual([resetId]);
    expect(h.store.listSessions()).toHaveLength(2);
    expect(h.store.getSession('old')).toEqual(savedSession());
    // The loaded totals still seeded the run — they land in the new row.
    expect(h.store.getSession(resetId)!.drops).toEqual({'300': 4, [ITEM_LOOT]: 3});
  });
});

describe('TrackingService — pause / resume', () => {
  it('broadcasts session_status and logs', () => {
    const h = build();
    h.service.start();
    init(h);

    h.service.pause();
    expect(events(h).at(-1)).toMatchObject({type: 'session_status', status: 'paused'});
    expect(h.log.info).toHaveBeenCalledWith('engine', 'Engine paused');

    h.service.resume();
    expect(events(h).at(-1)).toMatchObject({type: 'session_status', status: 'running'});
    expect(h.log.info).toHaveBeenCalledWith('engine', 'Engine resumed');
  });

  it('without an engine: no throw, no broadcast, still logs (as today)', () => {
    const h = build();
    expect(() => { h.service.pause(); h.service.resume(); }).not.toThrow();
    expect(h.sent).toEqual([]);
    expect(h.log.info).toHaveBeenCalledWith('engine', 'Engine paused');
    expect(h.log.info).toHaveBeenCalledWith('engine', 'Engine resumed');
  });
});

describe('TrackingService — consumer isolation', () => {
  it('a throwing store still broadcasts the session finish and leaves the engine fully stopped', () => {
    const h = build();
    const insert = vi.spyOn(h.store, 'insertSession').mockImplementation(() => { throw new Error('disk full'); });

    h.service.start();
    init(h);
    runMap(h);
    h.service.stop();

    expect(sessionFinishedIndex(h)).toBeGreaterThanOrEqual(0);
    expect(savedIds(h)).toEqual([]);
    expect(h.log.error).toHaveBeenCalledWith('engine', expect.stringContaining("'persistence'"));
    expect(h.store.listSessions()).toEqual([]);

    // The stopped engine no longer reacts to raw events.
    const before = h.sent.length;
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 9});
    vi.advanceTimersByTime(5_000);
    expect(h.sent.length).toBe(before);

    // A following start initialises cleanly and saves normally.
    insert.mockRestore();
    h.sent.length = 0;
    h.service.start();
    expect(types(h)).toEqual(['init_started']);
    init(h);
    expect(types(h)).toContain('init_complete');
    runMap(h);
    h.service.stop();
    expect(savedIds(h)).toHaveLength(1);
    expect(h.store.listSessions()).toHaveLength(1);
  });

  it('a throwing wealth snapshot skips only its own wealth_recorded', () => {
    const h = build();
    h.wealth.snapshot.mockImplementation(() => { throw new Error('wealth boom'); });

    h.service.start();
    init(h);
    runMap(h);
    h.service.stop();

    const t = types(h);
    expect(t).toContain('init_complete');
    expect(t).toContain('map_ended');
    expect(t).not.toContain('wealth_recorded');
    expect(h.log.error).toHaveBeenCalledWith('engine', expect.stringContaining("'wealth'"));
    expect(savedIds(h)).toHaveLength(1);
  });

  it('a throwing broadcast does not stop the item insert, wealth or persistence', () => {
    const h = build({
      broadcast: sent => (channel, payload) => {
        if ((payload as EngineEvent | undefined)?.type === 'init_complete') throw new Error('window gone');
        sent.push({channel, payload});
      },
    });

    h.service.start();
    init(h);
    runMap(h);
    h.service.stop();

    expect(types(h)).not.toContain('init_complete');
    expect(h.log.error).toHaveBeenCalledWith('engine', expect.stringContaining("'broadcast'"));
    expect(h.items.insertIfMissing).toHaveBeenCalledWith(String(ITEM_BAG));
    expect(h.wealth.snapshot).toHaveBeenCalledTimes(2); // init_complete + map_ended
    expect(types(h)).toContain('tracker_started');      // later events still go out
    expect(savedIds(h)).toHaveLength(1);
    expect(h.store.listSessions()).toHaveLength(1);
  });

  it('a throwing item insert does not stop the event broadcast', () => {
    const h = build();
    h.items.insertIfMissing.mockImplementation(() => { throw new Error('locked db'); });

    h.service.start();
    init(h);

    expect(types(h)).toContain('new_item');
    expect(types(h)).toContain('init_complete');
    expect(h.log.error).toHaveBeenCalledWith('engine', expect.stringContaining("'new_item'"));
  });
});

describe('TrackingService — idempotency', () => {
  it('stop without a run is a no-op', () => {
    const h = build();
    expect(() => h.service.stop()).not.toThrow();
    expect(h.sent).toEqual([]);
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it('stop twice saves once', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    h.service.stop();
    h.service.stop();

    expect(savedIds(h)).toHaveLength(1);
    expect(h.store.listSessions()).toHaveLength(1);
  });

  it('start twice saves the first run and starts the second fresh', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h, ITEM_LOOT, 3);

    h.service.start();
    const [firstId] = savedIds(h);
    expect(h.store.getSession(firstId)!.drops).toEqual({[ITEM_LOOT]: 3});
    expect(types(h).filter(t => t === 'init_started')).toHaveLength(2);

    init(h);
    runMap(h, ITEM_LOOT2, 2, 3);
    h.service.stop();

    const ids = savedIds(h);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(firstId);
    expect(h.store.getSession(ids[1])!.drops).toEqual({[ITEM_LOOT2]: 2});
  });

  it('stop before init completes saves nothing', () => {
    const h = build();
    h.service.start();
    h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: ITEM_BAG, quantity: 5}); // dump still open
    h.service.stop();

    expect(sessionFinishedIndex(h)).toBe(-1);
    expect(savedIds(h)).toEqual([]);
    expect(h.store.listSessions()).toEqual([]);
  });
});

describe('TrackingService — price routing', () => {
  const price: RawEvent = {type: 'price_update', itemId: 555, price: 12.5, listings: [12, 13]};

  it('records the scrape, then items:changed (with priceDate), then engine:event — no engine needed', () => {
    const h = build();
    h.raw(price);

    expect(h.items.recordScrapedPrice).toHaveBeenCalledWith('555', 12.5, [12, 13], {updateItem: true});
    expect(h.sent).toEqual([
      {channel: 'items:changed', payload: {id: '555', changes: {price: 12.5, priceDate: NOW}}},
      {channel: 'engine:event',  payload: {type: 'price_update', itemId: 555, price: 12.5, timestamp: NOW}},
    ]);
  });

  it('omits priceDate from the patch when the item row was not updated', () => {
    const h = build();
    h.items.recordScrapedPrice.mockReturnValue({priceDate: null});
    h.raw(price);
    expect(h.sent[0]).toEqual({channel: 'items:changed', payload: {id: '555', changes: {price: 12.5}}});
  });

  it('a locked item records history only — no broadcast', () => {
    const h = build();
    h.items.getLocked.mockReturnValue(true);
    h.raw(price);

    expect(h.items.recordScrapedPrice).toHaveBeenCalledWith('555', 12.5, [12, 13], {updateItem: false});
    expect(h.sent).toEqual([]);
    expect(h.log.debug).toHaveBeenCalledWith('price', expect.stringContaining('skipped (locked)'));
  });

  it('a non-price raw event with no engine is dropped', () => {
    const h = build();
    expect(() => h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP})).not.toThrow();
    expect(h.sent).toEqual([]);
  });
});

describe('TrackingService — worker and wiring', () => {
  it('new_item inserts a placeholder row and logs when inserted', () => {
    const h = build();
    h.service.start();
    init(h);
    expect(h.items.insertIfMissing).toHaveBeenCalledWith(String(ITEM_BAG));
    expect(h.log.info).toHaveBeenCalledWith('database', `New item discovered: id=${ITEM_BAG}`);
  });

  it('forwards raw events to the engine only while running', () => {
    const h = build();
    init(h); // before start — dropped
    expect(h.sent).toEqual([]);

    h.service.start();
    init(h);
    expect(types(h)).toContain('init_complete');

    h.service.stop();
    const before = h.sent.length;
    runMap(h);
    expect(h.sent.length).toBe(before);
  });

  it('without a torchlight path: warns, skips worker.start, still starts the engine', () => {
    const h = build({settings: {}});
    h.service.start();

    expect(h.worker.start).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledWith('worker', expect.any(String));
    expect(types(h)).toEqual(['init_started']);
    init(h);
    expect(types(h)).toContain('init_complete');
  });

  it('startWorker starts the worker only when the path resolves', () => {
    const withPath = build();
    withPath.service.startWorker();
    expect(withPath.worker.start).toHaveBeenCalledWith(LOG_PATH);

    const without = build({settings: {}});
    without.service.startWorker();
    expect(without.worker.start).not.toHaveBeenCalled();
  });

  it('shutdown auto-saves the run and stops the worker', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    h.service.shutdown();

    expect(savedIds(h)).toHaveLength(1);
    expect(h.worker.stop).toHaveBeenCalledTimes(1);
  });

  it('setItemType maps the raw type; pass-throughs are no-ops without an engine', () => {
    const h = build();
    expect(() => {
      h.service.setItemType('7', 'not-a-type');
      h.service.dismissMaterial(1);
      h.service.setLowStockThreshold(3);
      h.service.setOverrealmLootDurationMs(1);
      h.service.setFilterRules(null);
    }).not.toThrow();
    expect(h.log.debug).not.toHaveBeenCalled();

    h.service.start();
    const engine = h.engines[0];
    const setItemType   = vi.spyOn(engine, 'setItemType');
    const setOverrealm  = vi.spyOn(engine, 'setOverrealmLootDurationMs');
    const setSandlord   = vi.spyOn(engine, 'setSandlordWaveDurationMs');
    const setFilter     = vi.spyOn(engine, 'setFilterRules');

    h.service.setItemType('7', 'not-a-type');
    h.service.setOverrealmLootDurationMs(4_000);
    h.service.setSandlordWaveDurationMs(9_000);
    h.service.setFilterRules([]);

    expect(setItemType).toHaveBeenCalledWith('7', 'other');
    expect(setOverrealm).toHaveBeenCalledWith(4_000);
    expect(setSandlord).toHaveBeenCalledWith(9_000);
    expect(setFilter).toHaveBeenCalledWith([]);
    expect(h.log.debug).toHaveBeenCalledWith('filter', 'Filter rules updated: 0 rules');
  });
});
