/**
 * Adversarial TrackingService cases: re-entrancy, reset buffering, continue+reset,
 * event ordering/wealth gating, errors outside the fan-out, bad filter state,
 * price-routing propagation, worker lifecycle, stale-persistence references.
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
import {TOWN, MAP, SANDLORD_HUB} from '@/main/engine/__tests__/seasonal-fixtures';

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const LOG_PATH   = `${TORCHLIGHT}/${LOG_SUBPATH}`;
const NOW        = new Date('2026-03-01T12:00:00Z').getTime();
const ITEM_BAG   = 100;
const ITEM_LOOT  = 200;
const ITEM_LOOT2 = 201;

interface Sent {channel: string; payload: unknown}

interface Harness {
  service: TrackingService;
  store:   SqliteSessionStore;
  sent:    Sent[];
  worker:  {start: Mock<(logPath: string) => void>; stop: Mock<() => void>};
  createWorker: Mock;
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
  engines:  Engine[];
}

function build(opts: {broadcast?: (sent: Sent[], h: () => Harness) => Broadcast} = {}): Harness {
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
  const settings = {torchlightPath: TORCHLIGHT} as Record<string, string>;
  const filters: DbItemFilter[] = [];
  const wealth  = {snapshot: vi.fn<(engine: Engine) => void>()};
  const log     = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const createWorker = vi.fn((cb: (raw: RawEvent) => void): LogWorker => { onEvent = cb; return worker; });
  let self: Harness;
  const broadcast: Broadcast = opts.broadcast?.(sent, () => self) ?? ((channel, payload) => { sent.push({channel, payload}); });

  const service = new TrackingService({
    createEngine:   emit => { const e = createProductionEngine(emit); engines.push(e); return e; },
    store, broadcast, createWorker,
    settings:       {getAll: () => settings},
    filters:        {getAll: () => filters},
    items, wealthRecorder: wealth, log,
  });
  const raw = (event: RawEvent) => { onEvent!(event); };
  self = {service, store, sent, worker, createWorker, raw, items, settings, filters, wealth, log, engines};
  return self;
}

function init(h: Harness): void {
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: ITEM_BAG, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});
}
function runMap(h: Harness, itemId = ITEM_LOOT, qty = 3, slotId = 2): void {
  h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
  h.raw({type: 'bag_update', pageId: 0, slotId, itemId, quantity: qty});
  vi.advanceTimersByTime(60_000);
  h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
}
const events = (h: Harness): EngineEvent[] =>
  h.sent.filter(s => s.channel === 'engine:event').map(s => s.payload as EngineEvent);
const types = (h: Harness): string[] => events(h).map(e => e.type);
const savedEvents = (h: Harness): Array<{sessionId: string; deleted?: true}> =>
  events(h).flatMap(e => (e.type === 'session_saved' ? [e] : []));
/** Ids saved (not deleted) at least once, first-seen order. */
const savedIds = (h: Harness): string[] =>
  [...new Set(savedEvents(h).filter(e => !e.deleted).map(e => e.sessionId))];
/** The run's session id while an engine exists. */
const activeId = (h: Harness): string => h.service.getActiveSessionId()!;
function savedSession(over: Partial<DbSession> = {}): DbSession {
  return {
    id: 'old', name: 'My run', savedAt: '2026-02-01T10:00:00.000Z', totalTime: 120, mapTime: 100,
    mapCount: 2, drops: {'300': 4}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {}, spent: {}, endedAt: Date.parse('2026-02-01T10:00:00.000Z'), ...over,
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('adversarial - re-entrancy', () => {
  it('a broadcast that calls stop() during map_ended: no throw, session saved once, service ends stopped', () => {
    let fired = false;
    const h = build({broadcast: (sent, get) => (channel, payload) => {
      sent.push({channel, payload});
      if (!fired && (payload as EngineEvent | undefined)?.type === 'map_ended') {
        fired = true;
        get().service.stop();
      }
    }});
    h.service.start();
    init(h);
    expect(() => runMap(h)).not.toThrow();
    expect(savedIds(h)).toHaveLength(1);
    expect(h.store.listSessions()).toHaveLength(1);
    const before = h.sent.length;
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 50});
    expect(h.sent.length).toBe(before);
    expect(() => h.service.stop()).not.toThrow();
    expect(savedIds(h)).toHaveLength(1);
  });

  it('a broadcast that calls start() during the session tracker_finished (inside stop()) is torn down by the outer stop (characterization)', () => {
    let fired = false;
    const h = build({broadcast: (sent, get) => (channel, payload) => {
      sent.push({channel, payload});
      const e = payload as EngineEvent | undefined;
      if (!fired && e?.type === 'tracker_finished' && e.tracker.kind === 'session') {
        fired = true;
        get().service.start();
      }
    }});
    h.service.start();
    init(h);
    runMap(h);
    expect(() => h.service.stop()).not.toThrow();
    expect(savedIds(h)).toHaveLength(1);
    expect(h.engines).toHaveLength(2);
    // The outer stop()'s finally nulls the engine start() just installed.
    const before = h.sent.length;
    h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: ITEM_BAG, quantity: 5});
    expect(h.sent.length).toBe(before);
  });
});

describe('adversarial - reset', () => {
  it('reset mid-map: the old session and its rows are deleted; the in-flight map is map #1 of the new session', () => {
    const h = build();
    h.service.start();
    init(h);
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 3});
    vi.advanceTimersByTime(40_000);
    const firstId = activeId(h);

    h.service.reset();
    const resetId = activeId(h);
    expect(resetId).not.toBe(firstId);
    expect(events(h).some(e => e.type === 'tracker_finished' && e.tracker.kind === 'map')).toBe(true);
    // The row of the discarded run is gone at once, the new one is already there.
    expect(h.store.getSession(firstId)).toBeNull();
    expect(h.store.getSession(resetId)).toMatchObject({endedAt: null, mapCount: 1});

    h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
    h.raw({type: 'bag_update', pageId: 0, slotId: 3, itemId: ITEM_LOOT2, quantity: 2});
    vi.advanceTimersByTime(60_000);
    h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
    h.service.stop();

    expect(h.store.getSession(firstId)).toBeNull();
    expect(h.store.getRows(firstId)).toEqual([]);
    const rows = h.store.getRows(resetId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.drops[String(ITEM_LOOT)]).toBeUndefined();
    expect(rows.map(r => r.mapIndex)).toEqual(rows.map((_, i) => i + 1));
  });

  it('continue into an existing id, then reset: the continued session is DELETED, a new one is saved under the new id', () => {
    const h = build();
    h.store.insertSession(savedSession());
    h.store.insertRows([{
      sessionId: 'old', mapIndex: 1, startedAt: 1, endedAt: 2, duration: 1, drops: {'300': 4}, spent: {},
      seasonalType: null, parentMapIndex: null, phase: null,
    }]);
    h.service.continueSession('old');
    init(h);
    runMap(h);
    h.service.reset();
    const resetId = activeId(h);
    expect(resetId).not.toBe('old');
    runMap(h, ITEM_LOOT2, 2, 3);
    h.service.stop();

    expect(savedIds(h)).toEqual(['old', resetId]);
    expect(savedEvents(h)).toContainEqual({type: 'session_saved', sessionId: 'old', deleted: true});
    expect(h.store.getSession('old')).toBeNull();
    expect(h.store.getRows('old')).toEqual([]);
    const s = h.store.getSession(resetId)!;
    expect(s.name).not.toBe('My run');
    expect(s.drops).toEqual({[ITEM_LOOT2]: 2});
  });

  it('reset after stop is a no-op', () => {
    const h = build();
    h.service.start();
    init(h);
    h.service.stop();
    const n = h.log.info.mock.calls.length;
    h.service.reset();
    expect(h.log.info.mock.calls.length).toBe(n);
  });

  it('wealth snapshots continue across reset, each given only the live engine (no session id)', () => {
    const h = build();
    h.service.start();
    init(h);
    h.service.reset();
    runMap(h);
    const calls = h.wealth.snapshot.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call).toEqual([h.engines[h.engines.length - 1]]);
  });
});

describe('adversarial - event ordering and wealth gating', () => {
  it('a unit write failing (rows insert) is isolated: no session_saved for it, the index is reused, Stop still closes the session', () => {
    const h = build();
    h.service.start();
    init(h);
    const id = activeId(h);
    const savedBefore = savedEvents(h).length;
    vi.spyOn(h.store, 'insertRows').mockImplementationOnce(() => { throw new Error('rows boom'); });

    runMap(h, ITEM_LOOT, 3);                       // this unit's write fails
    expect(savedEvents(h)).toHaveLength(savedBefore);
    expect(h.log.error).toHaveBeenCalledWith('engine', expect.stringContaining("'persistence'"));
    expect(h.store.getRows(id)).toEqual([]);
    expect(types(h)).toContain('map_ended');

    runMap(h, ITEM_LOOT2, 2, 3);                   // the next one lands on index 1
    expect(h.store.getRows(id).map(r => [r.mapIndex, r.drops])).toEqual([[1, {[ITEM_LOOT2]: 2}]]);

    h.service.stop();
    expect(events(h).some(e => e.type === 'tracker_finished' && e.tracker.kind === 'session')).toBe(true);
    expect(h.store.getSession(id)!.endedAt).not.toBeNull();
  });

  it('a final write failing is isolated: session tracker_finished still sent, the row stays live for crash-close', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    const id = activeId(h);
    vi.spyOn(h.store, 'closeSession').mockImplementation(() => { throw new Error('close boom'); });
    h.service.stop();

    expect(events(h).some(e => e.type === 'tracker_finished' && e.tracker.kind === 'session')).toBe(true);
    expect(h.log.error).toHaveBeenCalledWith('engine', expect.stringContaining("'persistence'"));
    expect(h.store.getSession(id)!.endedAt).toBeNull();
  });

  it('a throwing price reader (items.getAll) at save time is isolated', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    h.items.getAll.mockImplementation(() => { throw new Error('items boom'); });
    expect(() => h.service.stop()).not.toThrow();
    expect(events(h).some(e => e.type === 'tracker_finished' && e.tracker.kind === 'session')).toBe(true);
    expect(h.log.error).toHaveBeenCalledWith('engine', expect.stringContaining("'persistence'"));
  });

  it('town-started seasonal run with no map: wealth_recorded right after the seasonal tracker_finished', () => {
    const h = build();
    h.service.start();
    init(h);
    const base = h.wealth.snapshot.mock.calls.length;
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: SANDLORD_HUB});
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 2});
    vi.advanceTimersByTime(10_000);
    h.raw({type: 'zone_transition', fromScene: SANDLORD_HUB, toScene: TOWN});
    vi.advanceTimersByTime(120_000);

    const ev = events(h);
    const finIdx = ev.findIndex(e => e.type === 'tracker_finished' && e.tracker.kind === 'seasonal');
    expect(finIdx).toBeGreaterThanOrEqual(0);
    expect(ev.some(e => e.type === 'map_ended')).toBe(false);
    expect(ev[finIdx + 1]?.type).toBe('wealth_recorded');
    expect(h.wealth.snapshot.mock.calls.length).toBe(base + 1);
  });

  it('a seasonal inside a map gives no wealth point until map_ended', () => {
    const h = build();
    h.service.start();
    init(h);
    const base = h.wealth.snapshot.mock.calls.length;
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
    h.raw({type: 'zone_transition', fromScene: MAP, toScene: SANDLORD_HUB});
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 2});
    vi.advanceTimersByTime(10_000);
    h.raw({type: 'zone_transition', fromScene: SANDLORD_HUB, toScene: TOWN});
    vi.advanceTimersByTime(120_000);

    const ev = events(h);
    const mapEnd = ev.findIndex(e => e.type === 'map_ended');
    const seasonalFin = ev.findIndex(e => e.type === 'tracker_finished' && e.tracker.kind === 'seasonal');
    expect(seasonalFin).toBeGreaterThanOrEqual(0);
    expect(mapEnd).toBeGreaterThanOrEqual(0);
    expect(h.wealth.snapshot.mock.calls.length).toBe(base + 1);
    const lo = Math.min(seasonalFin, mapEnd);
    const hi = Math.max(seasonalFin, mapEnd);
    expect(ev.slice(lo, hi).some(e => e.type === 'wealth_recorded')).toBe(false);
  });
});

describe('adversarial - errors outside the fan-out', () => {
  it('stop() when engine.stop() throws: error propagates, engine and persistence still cleared', () => {
    const h = build();
    h.service.start();
    init(h);
    vi.spyOn(h.engines[0], 'stop').mockImplementation(() => { throw new Error('onStop boom'); });
    expect(() => h.service.stop()).toThrow('onStop boom');

    const before = h.sent.length;
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 9});
    expect(h.sent.length).toBe(before);
    const n = h.log.info.mock.calls.length;
    expect(() => h.service.stop()).not.toThrow();
    expect(h.log.info.mock.calls.length).toBe(n);

    h.service.start();
    init(h);
    expect(types(h).filter(t => t === 'init_complete')).toHaveLength(2);
  });

  it('shutdown() when engine.stop() throws: error propagates and the worker is still stopped', () => {
    const h = build();
    h.service.start();
    init(h);
    vi.spyOn(h.engines[0], 'stop').mockImplementation(() => { throw new Error('onStop boom'); });
    expect(() => h.service.shutdown()).toThrow('onStop boom');
    expect(h.worker.stop).toHaveBeenCalledTimes(1);
  });

  it('start() when the previous engine.stop() throws: propagates before a new engine is created', () => {
    const h = build();
    h.service.start();
    init(h);
    vi.spyOn(h.engines[0], 'stop').mockImplementation(() => { throw new Error('onStop boom'); });
    expect(() => h.service.start()).toThrow('onStop boom');
    expect(h.engines).toHaveLength(1);
  });
});

describe('adversarial - bad filter', () => {
  it('invalid rules JSON: start throws after engine.start(); engine and persistence stay set (as the old code)', () => {
    const h = build();
    h.filters.push({id: 'f', name: 'Bad', enabled: true, rules: '{not json'});
    expect(() => h.service.start()).toThrow(SyntaxError);

    expect(types(h)).toEqual(['init_started']);
    expect(h.log.info).not.toHaveBeenCalledWith('engine', 'Engine started');
    init(h);
    expect(types(h)).toContain('init_complete');
    runMap(h);
    h.service.stop();
    expect(savedIds(h)).toHaveLength(1);
  });

  it('a following start() recovers once the filter is fixed', () => {
    const h = build();
    h.filters.push({id: 'f', name: 'Bad', enabled: true, rules: 'nope'});
    expect(() => h.service.start()).toThrow();
    h.filters[0].rules = '[]';
    expect(() => h.service.start()).not.toThrow();
    expect(h.engines).toHaveLength(2);
    init(h);
    expect(types(h)).toContain('init_complete');
  });
});

describe('adversarial - price routing errors propagate', () => {
  const price: RawEvent = {type: 'price_update', itemId: 555, price: 12.5, listings: [12]};

  it('recordScrapedPrice throwing propagates; nothing broadcast', () => {
    const h = build();
    h.items.recordScrapedPrice.mockImplementation(() => { throw new Error('db locked'); });
    expect(() => h.raw(price)).toThrow('db locked');
    expect(h.sent).toEqual([]);
  });

  it('getLocked throwing propagates before any record/broadcast', () => {
    const h = build();
    h.items.getLocked.mockImplementation(() => { throw new Error('lock boom'); });
    expect(() => h.raw(price)).toThrow('lock boom');
    expect(h.items.recordScrapedPrice).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it('a throwing broadcast on the price path propagates (not isolated, as the old code)', () => {
    const h = build({broadcast: () => () => { throw new Error('win gone'); }});
    expect(() => h.raw(price)).toThrow('win gone');
  });

  it('price_update is never forwarded to the engine, even while running', () => {
    const h = build();
    h.service.start();
    const spy = vi.spyOn(h.engines[0], 'onRawEvent');
    h.raw(price);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('adversarial - worker lifecycle', () => {
  it('createWorker is called once across many start/stop/shutdown cycles', () => {
    const h = build();
    expect(h.createWorker).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) { h.service.start(); h.service.stop(); h.service.shutdown(); expect(() => h.service.continueSession('x')).toThrow(); }
    expect(h.createWorker).toHaveBeenCalledTimes(1);
  });

  it('after shutdown(), start() calls worker.start again with the same path', () => {
    const h = build();
    h.service.start();
    h.service.shutdown();
    expect(h.worker.stop).toHaveBeenCalledTimes(1);
    h.service.start();
    expect(h.worker.start).toHaveBeenCalledTimes(2);
    expect(h.worker.start).toHaveBeenLastCalledWith(LOG_PATH);
  });

  it('every start calls worker.start (idempotency is the worker\'s job); a refused continue does not; stop never stops the worker', () => {
    const h = build();
    h.service.start(); h.service.start();
    expect(() => h.service.continueSession('nope')).toThrow();
    expect(h.worker.start).toHaveBeenCalledTimes(2);
    h.service.stop();
    expect(h.worker.stop).not.toHaveBeenCalled();
  });

  it('the path is re-resolved on each start; a cleared path warns and skips worker.start', () => {
    const h = build();
    h.settings.torchlightPath = 'D:/Other';
    h.service.start();
    expect(h.worker.start).toHaveBeenLastCalledWith(`D:/Other/${LOG_SUBPATH}`);
    h.settings.torchlightPath = '';
    h.service.start();
    expect(h.worker.start).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledWith('worker', expect.any(String));
  });

  it('worker events after shutdown still route prices but never reach a stopped engine', () => {
    const h = build();
    h.service.start();
    init(h);
    h.service.shutdown();
    h.raw({type: 'price_update', itemId: 1, price: 2, listings: []});
    expect(h.items.recordScrapedPrice).toHaveBeenCalled();
    const before = h.sent.length;
    h.raw({type: 'bag_snapshot_start'});
    expect(h.sent.length).toBe(before);
  });
});

describe('adversarial - no emit reaches a stale persistence after stop', () => {
  it('timers pending in the engine at stop do not save, persist, broadcast or snapshot afterwards', () => {
    const h = build();
    h.service.start();
    init(h);
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
    h.raw({type: 'zone_transition', fromScene: MAP, toScene: SANDLORD_HUB});
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 2});
    h.raw({type: 'zone_transition', fromScene: SANDLORD_HUB, toScene: TOWN});
    h.service.stop();
    const sentBefore = h.sent.length;
    const snapBefore = h.wealth.snapshot.mock.calls.length;
    const sessionsBefore = h.store.listSessions().length;
    const insertSpy = vi.spyOn(h.store, 'insertSession');
    const updSpy = vi.spyOn(h.store, 'updateSessionTotals');
    const rowsSpy = vi.spyOn(h.store, 'insertRows');
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.sent.length).toBe(sentBefore);
    expect(h.wealth.snapshot.mock.calls.length).toBe(snapBefore);
    expect(h.store.listSessions().length).toBe(sessionsBefore);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updSpy).not.toHaveBeenCalled();
    expect(rowsSpy).not.toHaveBeenCalled();
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('start() twice: the first run\'s persistence is not reused (distinct ids saved)', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h, ITEM_LOOT, 1);
    h.service.start();
    init(h);
    runMap(h, ITEM_LOOT2, 1, 3);
    h.service.stop();
    expect(new Set(savedIds(h)).size).toBe(2);
    expect(h.store.listSessions()).toHaveLength(2);
  });
});
