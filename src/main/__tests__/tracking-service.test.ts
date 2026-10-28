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
import {Engine} from '@/main/engine/engine';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {DbItemFilter, DbSession} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
import {engineEvents, unwrapEngineEvent, type Sent} from '@/test/broadcast';
import {LOG_SUBPATH} from '@/shared/paths';
import {parseSettings} from '@/shared/settings';
import type {SqlConn} from '@/main/db/sql-conn';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {TOWN, MAP} from '@/main/engine/__tests__/seasonal-fixtures';

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const LOG_PATH   = `${TORCHLIGHT}/${LOG_SUBPATH}`;
const NOW        = new Date('2026-03-01T12:00:00Z').getTime();

const ITEM_BAG   = 100; // in the bag at init
const ITEM_LOOT  = 200; // picked up in a map
const ITEM_LOOT2 = 201; // picked up in a later map


interface Harness {
  service: TrackingService;
  store:   SqliteSessionStore;
  /** The connection behind `store` — a second store over it sees the same DB. */
  conn:    SqlConn;
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
  wealth:   {snapshot: Mock<(engine: Engine) => void>};
  log:      {debug: Mock; info: Mock; warn: Mock; error: Mock};
  /** Every engine the service created, in order. */
  engines:  Engine[];
}

function build(opts: {settings?: Record<string, string>; broadcast?: (sent: Sent[]) => Broadcast} = {}): Harness {
  const conn    = openMigratedNodeSqlite();
  const store   = new SqliteSessionStore(conn);
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
  const wealth  = {snapshot: vi.fn<(engine: Engine) => void>()};
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
  return {service, store, conn, sent, worker, raw, items, settings, filters, wealth, log, engines};
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

const events = (h: Harness): EngineEvent[] => engineEvents(h.sent);

const types = (h: Harness): string[] => events(h).map(e => e.type);

/** Every `session_saved` broadcast, in order (`deleted` per 2.1c's contract). */
const savedEvents = (h: Harness): Array<{sessionId: string; deleted?: true}> =>
  events(h).flatMap(e => (e.type === 'session_saved' ? [e] : []));

/** The ids that were saved (not deleted) at least once, first-seen order. */
const savedIds = (h: Harness): string[] =>
  [...new Set(savedEvents(h).filter(e => !e.deleted).map(e => e.sessionId))];

/** The run's session id while an engine exists. */
const activeId = (h: Harness): string | null => h.service.getActiveSessionId();

const deleteSession = (h: Harness, id: string): void => h.service.deleteSession(id);

const isTracking = (h: Harness): boolean => h.service.isTracking();

const sessionFinishedIndex = (h: Harness): number =>
  events(h).findIndex(e => e.type === 'tracker_finished' && e.tracker.kind === 'session');

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
    endedAt:       Date.parse('2026-02-01T10:00:00.000Z'),
    ...over,
  };
}

function oldRows() {
  return [1, 2].map(mapIndex => ({
    sessionId: 'old', mapIndex, startedAt: 1_000 * mapIndex, endedAt: 1_000 * mapIndex + 50_000, duration: 50_000,
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
    const id = activeId(h)!;
    h.service.stop();

    // One `session_saved` per write: the live insert, the map's unit, the final.
    expect(savedEvents(h).map(e => e.sessionId)).toEqual([id, id, id]);
    expect(savedEvents(h).some(e => e.deleted)).toBe(false);
    expect(savedIds(h)).toEqual([id]);

    const session = h.store.getSession(id);
    expect(session).toMatchObject({drops: {[ITEM_LOOT]: 3}, mapCount: 1, attribution: 'drop-through'});
    expect(h.store.getRows(id)).toMatchObject([{mapIndex: 1, drops: {[ITEM_LOOT]: 3}, parentMapIndex: null}]);

    const t = types(h);
    for (const type of ['init_started', 'init_complete', 'wealth_recorded', 'map_ended']) expect(t).toContain(type);
    expect(t.indexOf('init_started')).toBeLessThan(t.indexOf('init_complete'));
    expect(t.indexOf('init_complete')).toBeLessThan(t.indexOf('wealth_recorded'));
    // session_saved goes out BEFORE the session tracker_finished that caused it, the final one included.
    expect(t.indexOf('session_saved')).toBeGreaterThanOrEqual(0);
    expect(t.lastIndexOf('session_saved')).toBeLessThan(sessionFinishedIndex(h));

    // Wealth: init_complete + map_ended, each with the live engine only (points carry no session).
    expect(h.wealth.snapshot).toHaveBeenCalledTimes(2);
    for (const call of h.wealth.snapshot.mock.calls) expect(call).toEqual([h.engines[0]]);
    expect(t.filter(x => x === 'wealth_recorded')).toHaveLength(2);
  });

  it('configures the engine after start (filter + item types survive ctx.reset)', () => {
    const h = build();
    // ITEM_LOOT is hidden only through its type, so both must reach the engine.
    h.items.getAll.mockReturnValue([{id: String(ITEM_LOOT), name: 'Sword', type: 'equipment', price: 0, priceDate: 0}]);
    h.filters.push({id: 'f1', name: 'Mine', enabled: true, rules: JSON.stringify([
      {id: 'r1', action: 'hide', scopes: ['session', 'map'], kind: {type: 'by-type', itemType: 'equipment'}},
    ])});
    h.service.start();
    init(h);
    runMap(h, ITEM_LOOT, 3);
    runMap(h, ITEM_LOOT2, 2, 3);
    h.service.stop();

    const [id] = savedIds(h);
    expect(h.store.getSession(id)!.drops).toEqual({[ITEM_LOOT2]: 2});
    expect(h.log.info).toHaveBeenCalledWith('filter', 'Filter set: "Mine"');
    expect(h.log.info).toHaveBeenCalledWith('engine', 'Engine started');
  });
});

describe('TrackingService — continue', () => {
  it('keeps the name, adds old totals, and appends rows continuing the mapIndex ([1,2,3])', () => {
    const h = build();
    h.store.insertSession(savedSession());
    h.store.insertRows(oldRows());

    h.service.continueSession('old');
    expect(activeId(h)).toBe('old');
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
    expect(h.store.getRows('old').map(r => r.mapIndex)).toEqual([1, 2, 3]);
  });

  it('the next index follows the highest PRIMARY index: overlap rows and gaps do not matter', () => {
    const h = build();
    h.store.insertSession(savedSession());
    h.store.insertRows([
      ...oldRows(),
      {...oldRows()[1], seasonalType: 'overrealm' as const, parentMapIndex: 2},
      {...oldRows()[1], mapIndex: 7},
    ]);

    h.service.continueSession('old');
    init(h);
    runMap(h);
    h.service.stop();

    expect(h.store.getRows('old').map(r => r.mapIndex)).toEqual([1, 2, 2, 7, 8]);
  });

  it('reopens the row at init (endedAt null, seeded totals intact) and closes it again at Stop', () => {
    const h = build();
    h.store.insertSession(savedSession());

    h.service.continueSession('old');
    expect(h.store.getSession('old')).toEqual(savedSession());   // nothing is touched before the session exists
    init(h);
    expect(h.store.getSession('old')).toEqual({...savedSession(), endedAt: null});
    expect(h.store.listOpenSessions().map(s => s.id)).toEqual(['old']);

    h.service.stop();
    expect(h.store.getSession('old')!.endedAt).not.toBeNull();
    expect(h.store.listOpenSessions()).toEqual([]);
  });

  it('seeds dropsBySource and spent too, not only the drops', () => {
    const h = build();
    h.store.insertSession(savedSession({dropsBySource: {map: {'300': 4}}, spent: {'55': 2}}));

    h.service.continueSession('old');
    init(h);
    runMap(h);
    h.service.stop();

    const session = h.store.getSession('old')!;
    expect(session.spent).toEqual({'55': 2});
    expect(session.dropsBySource.map?.['300']).toBe(4);
    expect(session.dropsBySource.map?.[String(ITEM_LOOT)]).toBe(3);
  });

  it('an unknown id throws; nothing is stopped, created or started', () => {
    const h = build();
    expect(() => h.service.continueSession('nope')).toThrow();

    expect(h.engines).toHaveLength(0);
    expect(h.worker.start).not.toHaveBeenCalled();
    expect(activeId(h)).toBeNull();
    expect(isTracking(h)).toBe(false);
    expect(h.store.listSessions()).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it.each(['exclusive', 'legacy'] as const)('a %s-attribution session cannot be continued: throws, nothing starts', attribution => {
    const h = build();
    h.store.insertSession(savedSession({attribution}));

    expect(() => h.service.continueSession('old')).toThrow();

    expect(h.engines).toHaveLength(0);
    expect(h.worker.start).not.toHaveBeenCalled();
    expect(h.store.getSession('old')).toEqual(savedSession({attribution}));
  });

  it('a refused continue leaves the run in progress untouched (nothing stopped first)', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    const id = activeId(h)!;
    const before = h.sent.length;

    expect(() => h.service.continueSession('nope')).toThrow();

    expect(h.engines).toHaveLength(1);
    expect(activeId(h)).toBe(id);
    expect(h.sent.length).toBe(before);
    expect(h.store.getSession(id)!.endedAt).toBeNull();
    expect(h.worker.start).toHaveBeenCalledTimes(1);
  });

  it('continuing the session being tracked throws; the run goes on', () => {
    const h = build();
    h.service.start();
    init(h);
    const id = activeId(h)!;

    expect(() => h.service.continueSession(id)).toThrow();

    expect(h.engines).toHaveLength(1);
    expect(activeId(h)).toBe(id);
    expect(h.store.getSession(id)!.endedAt).toBeNull();
  });
});

describe('TrackingService — live session', () => {
  it('start() generates the identity: an id while the engine exists, no row until the session opens', () => {
    const h = build();
    expect(activeId(h)).toBeNull();
    expect(isTracking(h)).toBe(false);

    h.service.start();
    const id = activeId(h)!;
    expect(id).toEqual(expect.any(String));
    expect(isTracking(h)).toBe(true);
    expect(h.store.getSession(id)).toBeNull();
    expect(h.store.listSessions()).toEqual([]);

    h.service.stop();
    expect(activeId(h)).toBeNull();
    expect(isTracking(h)).toBe(false);
  });

  it('each start() gets a new id and a local-time name taken at start', () => {
    const h = build();
    h.service.start();
    const first = activeId(h)!;
    h.service.start();
    const second = activeId(h)!;
    expect(second).not.toBe(first);

    init(h);
    expect(h.store.getSession(second)!.name).toMatch(/^Session - /);
  });

  it('the session row exists (live, empty totals) right after init_complete', () => {
    const h = build();
    h.service.start();
    init(h);
    const id = activeId(h)!;

    expect(h.store.getSession(id)).toMatchObject({endedAt: null, totalTime: 0, mapCount: 0, drops: {}, attribution: 'drop-through'});
    expect(savedEvents(h)).toEqual([{type: 'session_saved', sessionId: id}]);
  });

  it('rows and totals appear after each map, BEFORE stop, with a session_saved each', () => {
    const h = build();
    h.service.start();
    init(h);
    const id = activeId(h)!;

    runMap(h, ITEM_LOOT, 3);
    expect(h.store.getRows(id).map(r => [r.mapIndex, r.drops])).toEqual([[1, {[ITEM_LOOT]: 3}]]);
    expect(h.store.getSession(id)).toMatchObject({mapCount: 1, drops: {[ITEM_LOOT]: 3}, endedAt: null});
    expect(savedEvents(h)).toHaveLength(2);                       // insert + the map's unit
    expect(sessionFinishedIndex(h)).toBe(-1);

    runMap(h, ITEM_LOOT2, 2, 3);
    expect(h.store.getRows(id).map(r => r.mapIndex)).toEqual([1, 2]);
    expect(h.store.getSession(id)).toMatchObject({mapCount: 2, drops: {[ITEM_LOOT]: 3, [ITEM_LOOT2]: 2}, endedAt: null});
    expect(savedEvents(h)).toHaveLength(3);
    expect(sessionFinishedIndex(h)).toBe(-1);
  });

  it('a prices snapshot is merged in as the run goes, before stop', () => {
    const h = build();
    h.items.getAll.mockReturnValue([{id: String(ITEM_LOOT), name: 'Gem', type: 'other', price: 4, priceDate: 0}]);
    h.service.start();
    init(h);
    const id = activeId(h)!;
    runMap(h, ITEM_LOOT, 3);

    expect(h.store.getSession(id)!.priceSnapshot).toEqual({[String(ITEM_LOOT)]: 4});
  });

  it('stop closes the row: endedAt is the stop time', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    const id = activeId(h)!;
    vi.advanceTimersByTime(5_000);
    h.service.stop();

    expect(h.store.getSession(id)!.endedAt).toBe(Date.now());
    expect(h.store.listOpenSessions()).toEqual([]);
  });

  it('a run under 30 s with nothing in it is deleted at stop; session_saved says so (deleted: true)', () => {
    const h = build();
    h.service.start();
    init(h);
    const id = activeId(h)!;
    h.service.stop();

    expect(h.store.listSessions()).toEqual([]);
    expect(savedEvents(h)).toEqual([{type: 'session_saved', sessionId: id}, {type: 'session_saved', sessionId: id, deleted: true}]);
    expect(savedIds(h)).toEqual([id]);   // the live insert was announced too
    expect(events(h).map(e => e.type).lastIndexOf('session_saved')).toBeLessThan(sessionFinishedIndex(h));
  });

  it('a run of 30 s or more with nothing in it is kept', () => {
    const h = build();
    h.service.start();
    init(h);
    const id = activeId(h)!;
    vi.advanceTimersByTime(31_000);
    h.service.stop();

    expect(h.store.getSession(id)).toMatchObject({totalTime: expect.any(Number)});
    expect(h.store.getSession(id)!.endedAt).not.toBeNull();
    expect(savedEvents(h).some(e => e.deleted)).toBe(false);
  });

  it('a short run that completed a map is kept (rows exist)', () => {
    const h = build();
    h.service.start();
    init(h);
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
    vi.advanceTimersByTime(5_000);
    h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
    const id = activeId(h)!;
    h.service.stop();

    expect(h.store.getRows(id).length).toBeGreaterThan(0);
    expect(h.store.getSession(id)).not.toBeNull();
  });
});

describe('TrackingService — deleteSession and shutdown', () => {
  it('deleteSession refuses the active session (row and rows stay)', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    const id = activeId(h)!;

    expect(() => deleteSession(h, id)).toThrow();
    expect(h.store.getSession(id)).not.toBeNull();
    expect(h.store.getRows(id)).toHaveLength(1);
  });

  it('deleteSession removes another session with its rows, also while tracking', () => {
    const h = build();
    h.store.insertSession(savedSession());
    h.store.insertRows(oldRows());
    h.service.start();
    init(h);

    deleteSession(h, 'old');

    expect(h.store.getSession('old')).toBeNull();
    expect(h.store.getRows('old')).toEqual([]);
    expect(h.store.getSession(activeId(h)!)).not.toBeNull();
  });

  it('after stop the former active session can be deleted', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    const id = activeId(h)!;
    h.service.stop();

    deleteSession(h, id);
    expect(h.store.getSession(id)).toBeNull();
    expect(h.store.getRows(id)).toEqual([]);
  });

  it('deleteSession of an unknown id is a no-op', () => {
    const h = build();
    expect(() => deleteSession(h, 'nope')).not.toThrow();
  });

  it('shutdown twice stops the worker once and the second call is a no-op', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    h.service.shutdown();
    const sent = h.sent.length;
    h.service.shutdown();

    expect(h.worker.stop).toHaveBeenCalledTimes(1);
    expect(h.sent.length).toBe(sent);
    expect(h.store.listOpenSessions()).toEqual([]);
  });

  it('shutdown with no run still stops the worker, once', () => {
    const h = build();
    h.service.shutdown();
    h.service.shutdown();
    expect(h.worker.stop).toHaveBeenCalledTimes(1);
  });
});

describe('TrackingService — reset', () => {
  it('in tracking: deletes the old session and its rows, a new session row exists under a new id', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h, ITEM_LOOT, 3);
    const firstId = activeId(h)!;
    expect(h.store.getRows(firstId)).toHaveLength(1);

    h.service.reset();
    const resetId = activeId(h)!;

    expect(resetId).not.toBe(firstId);
    expect(h.store.getSession(firstId)).toBeNull();
    expect(h.store.getRows(firstId)).toEqual([]);
    // The new session's tracker_started inserted its row already.
    expect(h.store.getSession(resetId)).toMatchObject({endedAt: null, drops: {}, mapCount: 0});
    expect(savedEvents(h).at(-2)).toEqual({type: 'session_saved', sessionId: firstId, deleted: true});
    expect(savedEvents(h).at(-1)).toEqual({type: 'session_saved', sessionId: resetId});
  });

  it('saves under the NEW id with only post-reset drops', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h, ITEM_LOOT, 3);
    const firstId = activeId(h)!;

    h.service.reset();
    const resetId = activeId(h)!;
    runMap(h, ITEM_LOOT2, 2, 3);
    h.service.stop();

    expect(savedIds(h)).toEqual([firstId, resetId]);
    expect(h.store.getSession(firstId)).toBeNull();
    expect(h.store.getSession(resetId)!.drops).toEqual({[ITEM_LOOT2]: 2});
    expect(h.store.getSession(resetId)!.endedAt).not.toBeNull();
    expect(h.store.getRows(resetId)).toMatchObject([{mapIndex: 1, drops: {[ITEM_LOOT2]: 2}}]);
  });

  it('deletes the old session BEFORE engine.reset, so the new row is not hit by the old persistence', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    const firstId = activeId(h)!;
    const del = vi.spyOn(h.store, 'deleteSession');
    const ins = vi.spyOn(h.store, 'insertSession');

    h.service.reset();

    expect(del).toHaveBeenCalledWith(firstId);
    expect(ins).toHaveBeenCalledTimes(1);
    expect(del.mock.invocationCallOrder[0]).toBeLessThan(ins.mock.invocationCallOrder[0]);
  });

  it('is a no-op without an engine', () => {
    const h = build();
    expect(() => h.service.reset()).not.toThrow();
    expect(h.sent).toEqual([]);
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it('during initializing is a no-op: same id, nothing inserted or deleted', () => {
    const h = build();
    h.service.start();
    const id = activeId(h)!;
    const ins = vi.spyOn(h.store, 'insertSession');
    const del = vi.spyOn(h.store, 'deleteSession');

    h.service.reset();

    expect(activeId(h)).toBe(id);
    expect(ins).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(events(h).filter(e => e.type === 'session_saved')).toEqual([]);

    init(h);
    runMap(h);
    h.service.stop();
    expect(savedIds(h)).toEqual([id]);
    expect(h.store.listSessions().map(s => s.id)).toEqual([id]);
  });

  it('during the initializing of a continue is a no-op too: the stored session is untouched and still continues under its id', () => {
    const h = build();
    h.store.insertSession(savedSession());

    h.service.continueSession('old');
    h.service.reset();

    expect(activeId(h)).toBe('old');
    expect(h.store.getSession('old')).toEqual(savedSession());

    init(h);
    runMap(h);
    h.service.stop();

    expect(savedIds(h)).toEqual(['old']);
    expect(h.store.listSessions()).toHaveLength(1);
    expect(h.store.getSession('old')!.drops).toEqual({'300': 4, [ITEM_LOOT]: 3});
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
        if (channel === 'engine:event' && unwrapEngineEvent(payload).type === 'init_complete') throw new Error('window gone');
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

  it('records the scrape, then items:changed (with priceDate) — and no engine:event; no engine needed', () => {
    const h = build();
    h.raw(price);

    expect(h.items.recordScrapedPrice).toHaveBeenCalledWith('555', 12.5, [12, 13], {updateItem: true});
    expect(h.sent).toEqual([
      {channel: 'items:changed', payload: {id: '555', changes: {price: 12.5, priceDate: NOW}}},
    ]);
  });

  it('while tracking: items:changed only — no engine:event, and the engine never sees it', () => {
    const h = build();
    h.service.start();
    init(h);
    const engine = h.engines[0];
    const onRaw = vi.spyOn(engine, 'onRawEvent');
    const n = h.sent.length;
    h.raw(price);

    expect(h.sent.slice(n)).toEqual([
      {channel: 'items:changed', payload: {id: '555', changes: {price: 12.5, priceDate: NOW}}},
    ]);
    expect(onRaw).not.toHaveBeenCalled();
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
      h.service.reconfigure();
      h.service.setFilterRules(null);
    }).not.toThrow();
    expect(h.log.debug).not.toHaveBeenCalled();

    h.service.start();
    const engine = h.engines[0];
    const setItemType   = vi.spyOn(engine, 'setItemType');
    const setFilter     = vi.spyOn(engine, 'setFilterRules');

    h.service.setItemType('7', 'not-a-type');
    h.service.setFilterRules([]);

    expect(setItemType).toHaveBeenCalledWith('7', 'other');
    expect(setFilter).toHaveBeenCalledWith([]);
    expect(h.log.debug).toHaveBeenCalledWith('filter', 'Filter rules updated: 0 rules');
  });

  it('start configures the engine with the stored settings table', () => {
    const h = build({settings: {torchlightPath: TORCHLIGHT, carjackLootMs: '7000'}});
    const configure = vi.spyOn(Engine.prototype, 'configure');
    try {
      h.service.start();
      expect(configure).toHaveBeenCalledTimes(1);
      expect(configure).toHaveBeenCalledWith(parseSettings({torchlightPath: TORCHLIGHT, carjackLootMs: '7000'}));
    } finally {
      configure.mockRestore();
    }
  });

  it('reconfigure re-applies the stored table as it is now', () => {
    const h = build({settings: {torchlightPath: TORCHLIGHT, carjackLootMs: '7000', overrealmLootMs: '9000'}});
    h.service.start();
    const configure = vi.spyOn(h.engines[0], 'configure');

    // A written value replaces the stored one; the other keys keep theirs.
    h.settings['overrealmLootMs'] = '4000';
    h.service.reconfigure();
    expect(configure).toHaveBeenLastCalledWith(
      parseSettings({torchlightPath: TORCHLIGHT, carjackLootMs: '7000', overrealmLootMs: '4000'}));
    expect(h.settings).toEqual(
      {torchlightPath: TORCHLIGHT, carjackLootMs: '7000', overrealmLootMs: '4000'});   // reconfigure never writes

    h.settings['overrealmLootMs'] = '9000';
    h.settings['lowStockThreshold'] = '2';
    h.service.reconfigure();
    expect(configure).toHaveBeenLastCalledWith(parseSettings({
      torchlightPath: TORCHLIGHT, carjackLootMs: '7000', overrealmLootMs: '9000', lowStockThreshold: '2',
    }));
    expect(configure).toHaveBeenCalledTimes(2);
  });
});
