/**
 * Step 1.2 (test-first) — persistence of the entry cost.
 *
 * The row `spent` now comes from the finished tracker's own snapshot
 * (`TrackerSnapshot.spent`, string keys on the row), never from the engine;
 * the session record carries `DbSession.spent` from the session snapshot.
 * The engine stub below still offers `getLastMapSpends` returning a poison
 * basket: SessionPersistence must ignore it (the engine param stays until 1.6).
 *
 * APIs expected (absent today, reached via casts so this file typechecks):
 *   - `TrackerSnapshot.spent?: Record<number, number>`
 *   - `DbSession.spent: Record<string, number>` (required; round-trips through
 *     `SqliteSessionStore.insertSession / updateSessionTotals / getSession`)
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {SessionPersistence, type PriceReader, type SessionMeta} from '@/main/session-persistence';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {EngineEvent, SeasonalType, TrackerSnapshot} from '@/shared/contracts/engine';
import type {Engine} from '@/main/engine/engine';
import type {DbSession} from '@/shared/contracts/db';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';

/** What a stale implementation would read; row spent must never come from here. */
const POISON = {'999': 99};

function makeEngine(hasMap: boolean): Engine {
  return {
    hasActiveMapTracker: () => hasMap,
    getLastMapSpends:    () => POISON,
  } as unknown as Engine;
}

type Finished = Extract<EngineEvent, {type: 'tracker_finished'}>;

function trackerFinished(
  kind: 'session' | 'map' | 'seasonal',
  opts: {drops?: Record<number, number>; spent?: Record<number, number>; elapsed?: number; seasonalType?: SeasonalType} = {},
): Finished {
  const tracker: TrackerSnapshot & {spent?: Record<number, number>} = {
    kind,
    drops:   opts.drops ?? {},
    elapsed: opts.elapsed ?? 60_000,
    active:  true,
    ...(opts.seasonalType ? {seasonalType: opts.seasonalType} : {}),
    ...(opts.spent ? {spent: opts.spent} : {}),
  };
  return {type: 'tracker_finished', timestamp: 1_000_000, tracker};
}

const sessionSpent = (s: DbSession | null) => (s as (DbSession & {spent?: Record<string, number>}) | null)?.spent;

let store: SqliteSessionStore;

beforeEach(() => {
  store = new SqliteSessionStore(openMigratedNodeSqlite());
});

function make(meta: Partial<SessionMeta> = {}, readPrices: PriceReader = () => ({})): SessionPersistence {
  return new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false, ...meta}, {store, readPrices});
}

function finish(p: SessionPersistence, spent?: Record<number, number>, drops: Record<number, number> = {}) {
  const event = trackerFinished('session', {drops, spent});
  event.sessionMeta = {mapTime: 50_000, mapCount: 1};
  return p.onTrackerFinished(event, makeEngine(false));
}

describe('row spent comes from the finished tracker', () => {
  it('a map row stores the snapshot spent with string keys (engine poison ignored)', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {drops: {200: 5}, spent: {100: 3, 300: 2}}), makeEngine(true));
    finish(p);

    expect(store.getRows('s1')[0].spent).toEqual({'100': 3, '300': 2});
  });

  it('a map without cost stores {} (not the engine basket)', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {drops: {200: 5}}), makeEngine(true));
    finish(p);

    expect(store.getRows('s1')[0].spent).toEqual({});
  });

  it('a standalone seasonal row is {} even if the engine still holds a basket', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('seasonal', {drops: {200: 1}, seasonalType: 'sandlord'}), makeEngine(false));
    finish(p);

    const [row] = store.getRows('s1');
    expect(row).toMatchObject({seasonalType: 'sandlord', parentMapIndex: null});
    expect(row.spent).toEqual({});
  });

  it('an overlap seasonal row is {} while its parent map row carries the cost', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('seasonal', {drops: {300: 1}, seasonalType: 'overrealm'}), makeEngine(true));
    p.onTrackerFinished(trackerFinished('map', {drops: {200: 1}, spent: {100: 3}}), makeEngine(true));
    finish(p);

    const saved = store.getRows('s1');
    expect(saved.find(r => r.seasonalType === null)!.spent).toEqual({'100': 3});
    expect(saved.find(r => r.seasonalType === 'overrealm')!.spent).toEqual({});
  });

  it('two maps each keep their own cost', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {spent: {100: 3}}), makeEngine(true));
    p.onTrackerFinished(trackerFinished('map', {spent: {100: 1, 300: 2}}), makeEngine(true));
    finish(p);

    expect(store.getRows('s1').map(r => r.spent)).toEqual([{'100': 3}, {'100': 1, '300': 2}]);
  });
});

describe('session spent', () => {
  it('is saved from the session snapshot and round-trips through the store', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {spent: {100: 3}}), makeEngine(true));
    finish(p, {100: 4, 300: 2});

    expect(sessionSpent(store.getSession('s1'))).toEqual({'100': 4, '300': 2});
    expect(sessionSpent(store.listSessions()[0])).toEqual({'100': 4, '300': 2});
  });

  it('is {} when the session spent nothing', () => {
    const p = make();
    finish(p, undefined, {200: 1});
    expect(sessionSpent(store.getSession('s1'))).toEqual({});
  });

  it('a continued session overwrites spent with the new run totals (updateSessionTotals)', () => {
    store.insertSession({
      id: 's1', name: 'Run', savedAt: 'x', totalTime: 0, mapTime: 0, mapCount: 0,
      drops: {}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {},
      spent: {'100': 1},
    } as DbSession);
    expect(sessionSpent(store.getSession('s1'))).toEqual({'100': 1});

    const p = make({sessionName: 'Run', isOverride: true});
    finish(p, {100: 7, 300: 2}, {200: 1});

    expect(sessionSpent(store.getSession('s1'))).toEqual({'100': 7, '300': 2});
  });

  it('an own key named __proto__ survives the round trip as data', () => {
    store.insertSession({
      id: 'p1', name: 'Run', savedAt: 'x', totalTime: 0, mapTime: 0, mapCount: 0,
      drops: {}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {},
      spent: Object.fromEntries([['__proto__', 2], ['constructor', 1]]),
    } as DbSession);
    const spent = sessionSpent(store.getSession('p1'))!;
    expect(Object.keys(spent).sort()).toEqual(['__proto__', 'constructor']);
  });
});

describe('price snapshot covers spent ids', () => {
  it('asks the reader for row-spent and session-spent ids even when they never dropped', () => {
    const readPrices = vi.fn<PriceReader>(() => ({'100': 5, '42': 2, '43': 3, '999': 7}));
    const p = make({}, readPrices);

    p.onTrackerFinished(trackerFinished('map', {drops: {100: 1}, spent: {42: 3}}), makeEngine(true));
    finish(p, {43: 1}, {100: 1});

    expect(readPrices).toHaveBeenCalledTimes(1);
    // 100 dropped, 42 only in a row's spent, 43 only in the session spent. Never the poison 999.
    expect([...readPrices.mock.calls[0][0]].sort()).toEqual(['100', '42', '43']);
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 5, '42': 2, '43': 3});
  });

  it('a session that only spent (no drops) still reads prices for the spent ids', () => {
    const readPrices = vi.fn<PriceReader>(() => ({'43': 3}));
    const p = make({}, readPrices);
    finish(p, {43: 1});

    expect(readPrices).toHaveBeenCalledTimes(1);
    expect([...readPrices.mock.calls[0][0]]).toEqual(['43']);
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'43': 3});
  });
});
