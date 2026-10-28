/**
 * Step 2.1 adversarial: the DB always reflects the run as of the last finished
 * unit. Crash-close, failed unit writes, continue/reset/stop interleavings,
 * checkpoint == stored row on a real synthetic log, price-snapshot merge and
 * the `session_saved` stream. Real engine + real SqliteSessionStore.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {SqlConn} from '@/main/db/sql-conn';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import {configureEngine} from '@/main/engine/configure-engine';
import {closeCrashedSessions} from '@/main/session-recovery';
import {replay} from '@/replay/replay';
import {readLogText} from '@/replay/log-source';
import type {RawEvent} from '@/worker/processors/types';
import type {DbItem} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
import {engineEvents, unwrapEngineEvent, type Sent} from '@/test/broadcast';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {checkCheckpoints, checkUnits} from '@/test/unit-invariant';
import {GOLDEN_ITEMS} from '@/test/golden/items';
import {
  ARCANA_FIGHT, ARCANA_LEVEL, BODY, CARD, COMPASS, CUBE, FE, HUB_LEVEL, MAP, MATERIAL, PROBE, RARE_CARD,
  SANDLORD_HUB, Script, TOWN, TOWN_LEVEL,
} from '@/test/golden/synthetic';
import {TOWN as ETOWN, MAP as EMAP} from '@/main/engine/__tests__/seasonal-fixtures';

const NOW = new Date('2026-03-01T12:00:00Z').getTime();
const BAG = 100;            // consumed as entry cost
const L1 = 200, L2 = 201, L3 = 202;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

// -- harness -----------------------------------------------------------------


function build(opts: {onBroadcast?: (e: EngineEvent) => void; prices?: Record<number, number>} = {}) {
  const conn: SqlConn = openMigratedNodeSqlite();
  const store = new SqliteSessionStore(conn);
  const sent: Sent[] = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const worker = {start: vi.fn(), stop: vi.fn()};
  const prices: Record<number, number> = opts.prices ?? {};
  const log = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const service = new TrackingService({
    createEngine:   emit => createProductionEngine(emit),
    store,
    broadcast:      (channel, payload) => {
      sent.push({channel, payload});
      if (channel === 'engine:event') opts.onBroadcast?.(unwrapEngineEvent(payload));
    },
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => ({torchlightPath: 'C:/Games/TLI'})},
    filters:        {getAll: () => []},
    items:          {
      getAll: () => Object.entries(prices).map(([id, price]): DbItem => ({id, name: id, type: 'other', price, priceDate: 0})),
      getLocked: () => false, insertIfMissing: () => true, recordScrapedPrice: () => ({priceDate: NOW}),
    },
    wealthRecorder: {snapshot: vi.fn()},
    log,
  });
  let bag = 5;
  let slot = 2;
  const slots = new Map<number, number>();
  const held = new Map<number, number>();
  const raw = (e: RawEvent) => onEvent!(e);
  const h = {
    service, store, conn, sent, worker, log, prices, raw,
    events: () => engineEvents(sent),
    saved:  () => h.events().flatMap(e => (e.type === 'session_saved' ? [e] : [])),
    init: () => {
      raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: BAG, quantity: bag});
      for (const [id, s] of slots) raw({type: 'bag_init', pageId: 0, slotId: s, itemId: id, quantity: held.get(id) ?? 0});
      raw({type: 'bag_snapshot_start'});
    },
    /** town -> map (optionally paying `spend` of BAG first), loot, `ms`, back to town. */
    map: (loot: Array<[number, number]> = [[L1, 3]], o: {spend?: number; ms?: number} = {}) => {
      h.enter(loot, o.spend);
      vi.advanceTimersByTime(o.ms ?? 60_000);
      h.leave();
    },
    enter: (loot: Array<[number, number]> = [], spend = 0) => {
      if (spend > 0) { bag -= spend; raw({type: 'bag_update', pageId: 0, slotId: 1, itemId: BAG, quantity: bag}); }
      raw({type: 'zone_transition', fromScene: ETOWN, toScene: EMAP});
      for (const [id, q] of loot) {
        if (!slots.has(id)) slots.set(id, slot++);
        const total = (held.get(id) ?? 0) + q;
        held.set(id, total);
        raw({type: 'bag_update', pageId: 0, slotId: slots.get(id)!, itemId: id, quantity: total});
      }
    },
    leave: () => raw({type: 'zone_transition', fromScene: EMAP, toScene: ETOWN}),
  };
  return h;
}
type H = ReturnType<typeof build>;

const primaryIndexes = (h: H, id: string) => h.store.getRows(id).filter(r => r.parentMapIndex === null).map(r => r.mapIndex);

/** Duplicate (session_id, map_index) among PRIMARY rows anywhere in the DB, by SQL. */
function dupPrimaries(conn: SqlConn): unknown[] {
  return conn.prepare(
    'SELECT session_id, map_index, COUNT(*) AS c FROM session_maps WHERE parent_map_index IS NULL GROUP BY session_id, map_index HAVING c > 1',
  ).all();
}
const orphanRows = (conn: SqlConn): unknown[] =>
  conn.prepare('SELECT DISTINCT session_id FROM session_maps WHERE session_id NOT IN (SELECT id FROM sessions)').all();

const sessionCount = (h: H) => h.store.listSessions().length;

// ---------------------------------------------------------------------------

describe('crash mid-run', () => {
  it('crash-close on a fresh store: totals == last unit, endedAt == its saved_at, exactly N rows, in-flight map lost', () => {
    const h = build();
    h.service.start();
    h.init();
    h.map([[L1, 3]], {spend: 1});
    h.map([[L2, 2]]);
    h.map([[L1, 4]], {spend: 2});
    const id = h.service.getActiveSessionId()!;
    const afterThree = h.store.getSession(id)!;
    expect(afterThree.endedAt).toBeNull();
    expect(afterThree.mapCount).toBe(3);

    // In-flight 4th map: loot picked up, never left. App dies here (no stop).
    h.enter([[L3, 9]]);
    vi.advanceTimersByTime(20_000);
    expect(h.store.getSession(id)).toEqual(afterThree);

    const fresh = new SqliteSessionStore(h.conn);
    closeCrashedSessions(fresh, h.log);

    const closed = fresh.getSession(id)!;
    expect(closed).toEqual({...afterThree, endedAt: Date.parse(afterThree.savedAt)});
    expect(closed.drops).toEqual({[L1]: 7, [L2]: 2});
    expect(closed.drops[L3]).toBeUndefined();
    expect(closed.spent).toEqual({[BAG]: 3});
    expect(fresh.getRows(id)).toHaveLength(3);
    expect(primaryIndexes(h, id)).toEqual([1, 2, 3]);
    expect(fresh.listOpenSessions()).toEqual([]);
    expect(dupPrimaries(h.conn)).toEqual([]);
  });

  it('crash before the first unit and under 30 s: the live row is deleted by crash-close', () => {
    const h = build();
    h.service.start();
    h.init();
    vi.advanceTimersByTime(5_000);
    const id = h.service.getActiveSessionId()!;
    expect(h.store.getSession(id)?.endedAt).toBeNull();
    closeCrashedSessions(new SqliteSessionStore(h.conn), h.log);
    expect(h.store.getSession(id)).toBeNull();
    expect(orphanRows(h.conn)).toEqual([]);
  });

  it('a throwing insertRows on unit k leaves units < k, the failed unit is lost and its index is reused', () => {
    const h = build();
    const orig = h.store.insertRows.bind(h.store);
    let calls = 0;
    vi.spyOn(h.store, 'insertRows').mockImplementation(rows => {
      calls++;
      if (calls === 3) throw new Error('disk full');
      orig(rows);
    });
    h.service.start();
    h.init();
    h.map([[L1, 1]]);
    h.map([[L1, 2]]);
    const id = h.service.getActiveSessionId()!;
    const before3 = h.store.getSession(id)!;

    h.map([[L1, 4]]);                       // unit 3: insertRows throws -> whole tx rolled back
    expect(calls).toBe(3);
    const afterFail = h.store.getSession(id)!;
    expect(afterFail).toEqual(before3);     // totals (and saved_at) rolled back with the rows
    expect(primaryIndexes(h, id)).toEqual([1, 2]);
    expect(h.log.error).toHaveBeenCalled();
    expect(h.saved().filter(e => !e.deleted)).toHaveLength(1 + 2);  // insert + 2 good units, none for the failure

    h.map([[L1, 8]]);                       // unit 4 reuses index 3
    expect(primaryIndexes(h, id)).toEqual([1, 2, 3]);
    expect(dupPrimaries(h.conn)).toEqual([]);
    // Totals are the engine's running totals: they include the lost unit's drops.
    expect(h.store.getSession(id)!.drops).toEqual({[L1]: 1 + 2 + 4 + 8});
    expect(h.store.getSession(id)!.mapCount).toBe(4);

    h.service.stop();
    expect(dupPrimaries(h.conn)).toEqual([]);
    expect(h.store.getSession(id)!.endedAt).not.toBeNull();
    expect(h.store.getSession(id)!.mapCount).toBe(4);
    expect(primaryIndexes(h, id)).toEqual([1, 2, 3]);
  });

  it('a throwing insertRows on the FIRST unit then recovering: index 1 is not skipped', () => {
    const h = build();
    const orig = h.store.insertRows.bind(h.store);
    let calls = 0;
    vi.spyOn(h.store, 'insertRows').mockImplementation(rows => { if (++calls === 1) throw new Error('boom'); orig(rows); });
    h.service.start();
    h.init();
    h.map();
    h.map();
    const id = h.service.getActiveSessionId()!;
    expect(primaryIndexes(h, id)).toEqual([1]);
    expect(dupPrimaries(h.conn)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('interleavings', () => {
  /** A saved, closed, continuable session with two maps. */
  function seedRun(h: H): string {
    h.service.start();
    h.init();
    h.map([[L1, 3]], {spend: 1});
    h.map([[L2, 2]]);
    const id = h.service.getActiveSessionId()!;
    h.service.stop();
    return id;
  }

  it('continue -> reset -> continue the deleted id: throws, the live run is untouched, nothing of it remains', () => {
    const h = build();
    const a = seedRun(h);
    h.service.continueSession(a);
    h.init();
    h.service.reset();
    expect(h.store.getSession(a)).toBeNull();
    expect(h.store.getRows(a)).toEqual([]);
    const fresh = h.service.getActiveSessionId()!;
    expect(fresh).not.toBe(a);

    expect(() => h.service.continueSession(a)).toThrow(/not found/);
    expect(h.service.getActiveSessionId()).toBe(fresh);
    expect(h.service.isTracking()).toBe(true);
    h.map();
    expect(primaryIndexes(h, fresh)).toEqual([1]);
    expect(orphanRows(h.conn)).toEqual([]);
  });

  it('continue A, stop, continue A again: three segments, indexes 1..n contiguous, totals cumulative', () => {
    const h = build();
    const a = seedRun(h);                                   // seg 1: 2 maps, L1 3 (spend 1), L2 2
    h.service.continueSession(a);                           // seg 2
    h.init();
    h.map([[L1, 5]], {spend: 2});
    h.map([[L3, 1]]);
    h.service.stop();
    expect(h.store.getSession(a)!.endedAt).not.toBeNull();
    h.service.continueSession(a);                           // seg 3
    h.init();
    h.map([[L2, 7]], {spend: 1});
    h.service.stop();

    expect(primaryIndexes(h, a)).toEqual([1, 2, 3, 4, 5]);
    expect(dupPrimaries(h.conn)).toEqual([]);
    const s = h.store.getSession(a)!;
    expect(s.mapCount).toBe(5);
    expect(s.drops).toEqual({[L1]: 3 + 5, [L2]: 2 + 7, [L3]: 1});
    expect(s.spent).toEqual({[BAG]: 1 + 2 + 1});
    const summed: Record<string, number> = {};
    for (const bucket of Object.values(s.dropsBySource)) for (const [k, q] of Object.entries(bucket ?? {})) summed[k] = (summed[k] ?? 0) + q;
    expect(summed).toEqual(s.drops);
    expect(s.attribution).toBe('drop-through');
    expect(s.endedAt).not.toBeNull();
    expect(sessionCount(h)).toBe(1);
    // rows' own drops add up to the session's
    const rowDrops: Record<string, number> = {};
    for (const r of h.store.getRows(a)) for (const [k, q] of Object.entries(r.drops)) rowDrops[k] = (rowDrops[k] ?? 0) + q;
    expect(rowDrops).toEqual(s.drops);
    expect(s.totalTime).toBeCloseTo(5 * 60, 0);
  });

  it('reset while paused: old row deleted, new row inserted, the run stays paused', () => {
    const h = build();
    h.service.start();
    h.init();
    h.map();
    const old = h.service.getActiveSessionId()!;
    h.service.pause();
    h.service.reset();
    const fresh = h.service.getActiveSessionId()!;
    expect(fresh).not.toBe(old);
    expect(h.store.getSession(old)).toBeNull();
    expect(h.store.getRows(old)).toEqual([]);
    expect(h.store.getSession(fresh)).toMatchObject({endedAt: null, mapCount: 0});

    const started = h.events().filter(e => e.type === 'tracker_started' && e.tracker.kind === 'session').at(-1);
    expect(started && started.type === 'tracker_started' && started.tracker.active).toBe(false);

    h.service.resume();
    h.map();
    expect(primaryIndexes(h, fresh)).toEqual([1]);
    expect(sessionCount(h)).toBe(1);
  });

  it('reset twice quickly: exactly one session row survives, each old one reported deleted', () => {
    const h = build();
    h.service.start();
    h.init();
    h.map();
    const a = h.service.getActiveSessionId()!;
    h.service.reset();
    const b = h.service.getActiveSessionId()!;
    h.service.reset();
    const c = h.service.getActiveSessionId()!;
    expect(new Set([a, b, c]).size).toBe(3);
    expect(h.store.listSessions().map(s => s.id)).toEqual([c]);
    expect(orphanRows(h.conn)).toEqual([]);
    expect(h.saved().filter(e => e.deleted).map(e => e.sessionId)).toEqual([a, b]);
    h.map();
    expect(primaryIndexes(h, c)).toEqual([1]);
    expect(dupPrimaries(h.conn)).toEqual([]);
  });

  it('stop during initializing after a previous run: no row for the new run, nothing deleted', () => {
    const h = build();
    const a = seedRun(h);
    const before = h.store.getSession(a)!;
    const rowsBefore = h.store.getRows(a);
    const savedBefore = h.saved().length;

    h.service.start();            // initializing: bag baseline never lands
    expect(h.service.isTracking()).toBe(true);
    h.service.stop();

    expect(h.store.listSessions().map(s => s.id)).toEqual([a]);
    expect(h.store.getSession(a)).toEqual(before);
    expect(h.store.getRows(a)).toEqual(rowsBefore);
    expect(h.saved().length).toBe(savedBefore);   // no session_saved at all
  });

  it('continue then stop during initializing: the saved session stays closed (not reopened)', () => {
    const h = build();
    const a = seedRun(h);
    const before = h.store.getSession(a)!;
    h.service.continueSession(a);
    h.service.stop();
    expect(h.store.getSession(a)).toEqual(before);
    expect(h.store.listOpenSessions()).toEqual([]);
  });

  it('continuing or deleting the active session is refused, nothing touched', () => {
    const h = build();
    h.service.start();
    h.init();
    h.map();
    const id = h.service.getActiveSessionId()!;
    expect(() => h.service.continueSession(id)).toThrow();
    expect(h.service.getActiveSessionId()).toBe(id);
    expect(h.store.getSession(id)!.endedAt).toBeNull();
    expect(() => h.service.deleteSession(id)).toThrow();
    expect(h.store.getSession(id)).not.toBeNull();
  });

  it('continue refuses a non-drop-through session without stopping the current run', () => {
    const h = build();
    const a = seedRun(h);
    h.conn.prepare("UPDATE sessions SET attribution = 'exclusive' WHERE id = ?").run(a);
    h.service.start();
    h.init();
    const live = h.service.getActiveSessionId()!;
    expect(() => h.service.continueSession(a)).toThrow(/exclusive/);
    expect(h.service.getActiveSessionId()).toBe(live);
    expect(h.store.getSession(live)!.endedAt).toBeNull();
    expect(h.store.getSession(a)!.endedAt).not.toBeNull();
  });

  it('shutdown inside the session_saved broadcast of the first unit: no throw, one closed row, no duplicate indexes', () => {
    let saves = 0;
    let svc: TrackingService | null = null;
    const h = build({onBroadcast: e => {
      if (e.type === 'session_saved' && ++saves === 2) svc?.shutdown();   // insert, then first unit
    }});
    svc = h.service;
    h.service.start();
    h.init();
    expect(() => { h.map(); h.map(); }).not.toThrow();
    h.service.shutdown();

    expect(h.worker.stop).toHaveBeenCalledTimes(1);
    expect(h.service.isTracking()).toBe(false);
    const rows = h.store.listSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0].endedAt).not.toBeNull();
    expect(h.store.listOpenSessions()).toEqual([]);
    expect(dupPrimaries(h.conn)).toEqual([]);
    expect(orphanRows(h.conn)).toEqual([]);
    expect(primaryIndexes(h, rows[0].id)).toEqual([1]);
    expect(rows[0].mapCount).toBe(1);
  });

  it('shutdown is idempotent and a start after it is a normal run', () => {
    const h = build();
    h.service.start();
    h.init();
    h.map();
    h.service.shutdown();
    h.service.shutdown();
    expect(h.worker.stop).toHaveBeenCalledTimes(1);
    h.service.start();
    h.init();
    h.map();
    h.service.stop();
    expect(sessionCount(h)).toBe(2);
    expect(h.store.listOpenSessions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('price snapshot merge', () => {
  it('first price wins across units; a later price change never rewrites an existing id', () => {
    const h = build({prices: {[L1]: 5, [L2]: 2}});
    h.service.start();
    h.init();
    h.map([[L1, 1]]);
    const id = h.service.getActiveSessionId()!;
    expect(h.store.getSession(id)!.priceSnapshot).toEqual({[L1]: 5});

    h.prices[L1] = 99;
    h.map([[L1, 1], [L2, 1]]);
    expect(h.store.getSession(id)!.priceSnapshot).toEqual({[L1]: 5, [L2]: 2});

    h.prices[L2] = 50;
    h.map([[L2, 1]]);
    expect(h.store.getSession(id)!.priceSnapshot).toEqual({[L1]: 5, [L2]: 2});
  });

  it('zero prices are not captured and do not block a later real price', () => {
    const h = build({prices: {[L1]: 0}});
    h.service.start();
    h.init();
    h.map([[L1, 1]]);
    const id = h.service.getActiveSessionId()!;
    expect(h.store.getSession(id)!.priceSnapshot).toEqual({});
    h.prices[L1] = 4;
    h.map([[L1, 1]]);
    expect(h.store.getSession(id)!.priceSnapshot).toEqual({[L1]: 4});
  });

  it('Stop-time merge only adds ids the units never saw (loot of the map still open at Stop)', () => {
    const h = build({prices: {[L1]: 5}});
    h.service.start();
    h.init();
    h.map([[L1, 1]]);
    const id = h.service.getActiveSessionId()!;
    expect(h.store.getSession(id)!.priceSnapshot).toEqual({[L1]: 5});

    h.prices[L1] = 9;
    h.prices[L3] = 7;
    h.enter([[L1, 2], [L3, 4]]);          // map still open: no unit for it
    expect(h.store.getSession(id)!.priceSnapshot).toEqual({[L1]: 5});
    h.service.stop();

    const s = h.store.getSession(id)!;
    expect(s.priceSnapshot).toEqual({[L1]: 5, [L3]: 7});
    expect(s.drops).toEqual({[L1]: 3, [L3]: 4});    // final write carries the open map's loot
    expect(s.endedAt).not.toBeNull();
  });

  it('a continued session keeps the stored snapshot and adds only new ids', () => {
    const h = build({prices: {[L1]: 5}});
    h.service.start();
    h.init();
    h.map([[L1, 1]]);
    const id = h.service.getActiveSessionId()!;
    h.service.stop();
    h.prices[L1] = 11;
    h.prices[L2] = 3;
    h.service.continueSession(id);
    h.init();
    h.map([[L1, 1], [L2, 1]]);
    h.service.stop();
    expect(h.store.getSession(id)!.priceSnapshot).toEqual({[L1]: 5, [L2]: 3});
  });
});

// ---------------------------------------------------------------------------

describe('session_saved stream', () => {
  it('one per write, in order; deleted:true exactly for deletes; unit_finished is never broadcast', () => {
    const h = build();
    h.service.start();
    expect(h.saved()).toEqual([]);                    // nothing until the baseline lands
    h.init();
    h.map();
    h.map();
    const a = h.service.getActiveSessionId()!;
    h.service.reset();                                // delete a, insert b
    const b = h.service.getActiveSessionId()!;
    h.map();
    h.service.stop();                                 // final save of b
    h.service.start();                                // empty run:
    h.init();
    const c = h.service.getActiveSessionId()!;
    vi.advanceTimersByTime(1_000);
    h.service.stop();                                 // deleted (<30 s, empty)

    expect(h.saved()).toEqual([
      {type: 'session_saved', sessionId: a},          // insert
      {type: 'session_saved', sessionId: a},          // unit 1
      {type: 'session_saved', sessionId: a},          // unit 2
      {type: 'session_saved', sessionId: a, deleted: true},
      {type: 'session_saved', sessionId: b},          // insert
      {type: 'session_saved', sessionId: b},          // unit
      {type: 'session_saved', sessionId: b},          // final
      {type: 'session_saved', sessionId: c},          // insert
      {type: 'session_saved', sessionId: c, deleted: true},
    ]);
    for (const e of h.saved()) expect(e.deleted === undefined || e.deleted === true).toBe(true);
    expect(h.events().some(e => (e.type as string) === 'unit_finished')).toBe(false);
    expect(h.store.getSession(c)).toBeNull();
    expect(h.store.listSessions().map(s => s.id)).toEqual([b]);
  });

  it('the last session_saved precedes the broadcast of the session tracker_finished', () => {
    const h = build();
    h.service.start();
    h.init();
    h.map();
    h.service.stop();
    const types = h.events().map(e => e.type);
    const lastSave = types.lastIndexOf('session_saved');
    const finished = h.events().findIndex(e => e.type === 'tracker_finished' && e.tracker.kind === 'session');
    expect(lastSave).toBeLessThan(finished);
  });
});

// ---------------------------------------------------------------------------

describe('checkpoint consistency on a real synthetic log', () => {
  const VOREX_REWARD = '/Game/Art/Season/S13/Maps/DiXiaZhenSuo/DiXiaZhenSuo.DiXiaZhenSuo';
  const VOREX_LEVEL: [number, number] = [9999997, 22];

  /** Standalone Arcana, a plain map, a map with a Vorex child, a map frozen by the hub, a plain map. */
  const text = new Script()
    .dump(0, [[FE, 500], [COMPASS, 10], [PROBE, 5], [MATERIAL, 50], [CARD, 3], [CUBE, 20]])
    .line(10, BODY.s9Minigame)
    .zone(12, TOWN, ARCANA_FIGHT, ARCANA_LEVEL)
    .bag(15, FE, 12).bag(16, CUBE, 2)
    .zone(30, ARCANA_FIGHT, TOWN, TOWN_LEVEL)
    .bag(40, COMPASS, -1).bag(40.4, PROBE, -1)
    .zone(41, TOWN, MAP, [5318, 3])
    .bag(50, FE, 12).bag(55, RARE_CARD, 1)
    .zone(70, MAP, TOWN, TOWN_LEVEL)
    .bag(100, COMPASS, -1)
    .zone(101, TOWN, MAP, [5318, 3])
    .bag(110, FE, 12)
    .line(120, BODY.s13Start).line(130, BODY.s13WindowClose).line(130.05, BODY.s13Abandon)
    .zone(130.55, MAP, VOREX_REWARD, VOREX_LEVEL)
    .bag(135, FE, 28).bag(137, MATERIAL, 8)
    .zone(150, VOREX_REWARD, TOWN, TOWN_LEVEL)
    .bag(160, COMPASS, -1)
    .zone(161, TOWN, MAP, [5318, 3])
    .bag(165, FE, 20)
    .zone(170, MAP, SANDLORD_HUB, HUB_LEVEL)
    .bag(175, FE, 20).bag(176, MATERIAL, 4)
    .zone(190, SANDLORD_HUB, TOWN, TOWN_LEVEL)
    .bag(200, PROBE, -1)
    .zone(201, TOWN, MAP, [5318, 3])
    .bag(210, FE, 5)
    .zone(230, MAP, TOWN, TOWN_LEVEL)
    .text();

  it('after every unit the stored row == its checkpoint; at the end stored totals == session tracker_finished', async () => {
    vi.useRealTimers();
    const conn = openMigratedNodeSqlite();
    type Snap = {session: ReturnType<SqliteSessionStore['getSession']>; rows: number};
    const snaps: Snap[] = [];
    let depth = 0;
    class Recording extends SqliteSessionStore {
      override transaction<T>(fn: () => T): T {
        depth++;
        try {
          const out = super.transaction(fn);
          if (depth === 1) snaps.push({session: this.getSession('s1'), rows: this.getRows('s1').length});
          return out;
        } finally { depth--; }
      }
    }
    const store = new Recording(conn);
    const items = GOLDEN_ITEMS;
    const result = await replay({
      source:      readLogText(text),
      sessionIds:  () => 's1',
      persistence: {store, readPrices: ids => Object.fromEntries([...ids].filter(i => items[i]).map(i => [i, items[i].price]))},
      configure:   engine => configureEngine(engine, {items: Object.values(items), filterRules: null, settings: {}}),
    });
    const events = result.events.map(e => e.event);
    const units = events.flatMap(e => (e.type === 'unit_finished' ? [e] : []));
    expect(units.length).toBeGreaterThanOrEqual(5);
    expect(units.some(u => u.tracker.kind === 'seasonal')).toBe(true);
    expect(units.some(u => u.overlaps.length > 0)).toBe(true);
    expect(checkUnits(events)).toEqual([]);
    expect(checkCheckpoints(events)).toEqual([]);

    // transactions: one per unit, then the final close.
    expect(snaps).toHaveLength(units.length + 1);
    const json = (v: unknown) => JSON.parse(JSON.stringify(v));
    let rowCount = 0;
    units.forEach((u, k) => {
      const cp = u.checkpoint;
      const s = snaps[k].session!;
      rowCount += 1 + u.overlaps.length;
      expect(snaps[k].rows, `unit ${k} rows`).toBe(rowCount);
      expect(s.drops, `unit ${k} drops`).toEqual(json(cp.session.drops));
      expect(s.spent, `unit ${k} spent`).toEqual(json(cp.session.spent ?? {}));
      expect(s.dropsBySource, `unit ${k} bySource`).toEqual(json(cp.session.dropsBySource ?? {}));
      expect(s.totalTime, `unit ${k} totalTime`).toBeCloseTo(cp.session.elapsed / 1000, 6);
      expect(s.mapTime, `unit ${k} mapTime`).toBeCloseTo(cp.mapTime / 1000, 6);
      expect(s.mapCount, `unit ${k} mapCount`).toBe(cp.mapCount);
      expect(s.endedAt, `unit ${k} live`).toBeNull();
    });

    const fin = events.flatMap(e => (e.type === 'tracker_finished' && e.tracker.kind === 'session' ? [e] : []))[0];
    const stored = store.getSession('s1')!;
    expect(stored.endedAt).toBe(fin.timestamp);
    expect(stored.drops).toEqual(json(fin.tracker.drops));
    expect(stored.spent).toEqual(json(fin.tracker.spent ?? {}));
    expect(stored.dropsBySource).toEqual(json(fin.tracker.dropsBySource ?? {}));
    expect(stored.totalTime).toBeCloseTo(fin.tracker.elapsed / 1000, 6);
    expect(stored.mapCount).toBe(fin.sessionMeta!.mapCount);
    expect(stored.mapTime).toBeCloseTo(fin.sessionMeta!.mapTime / 1000, 6);
    expect(store.getRows('s1')).toHaveLength(rowCount);
    // map indexes: unique and contiguous over primaries
    const prim = store.getRows('s1').filter(r => r.parentMapIndex === null).map(r => r.mapIndex);
    expect(prim).toEqual(prim.map((_, i) => i + 1));
    expect(dupPrimaries(conn)).toEqual([]);
  });
});
