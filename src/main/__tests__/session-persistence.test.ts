/**
 * Tests for SessionPersistence over the real SqliteSessionStore (node:sqlite).
 * Row routing for the three tracker_finished kinds:
 *   map      -> primary row (parentMapIndex=null), bumps mapIndex.
 *   seasonal (no active map) -> primary standalone row (Sandlord case).
 *   seasonal (active map)    -> overlap row pointing at the parent map's mapIndex.
 * Rows are only observable once the session event commits them, so routing
 * tests end with `finish()` and read back through the store.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {SessionPersistence, type PriceReader, type SessionMeta} from '@/main/session-persistence';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {EngineEvent, SeasonalPhase, SeasonalType, Source} from '@/shared/contracts/engine';
import type {Engine} from '@/main/engine/engine';
import type {DbSession} from '@/shared/contracts/db';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';

function makeEngine(opts: {hasMap: boolean; spends?: Record<string, number>}): Engine {
  return {
    hasActiveMapTracker: () => opts.hasMap,
    getLastMapSpends:    () => opts.spends ?? {},
  } as unknown as Engine;
}

function trackerFinished(
  kind: 'session' | 'map' | 'seasonal',
  drops: Record<number, number>,
  elapsed: number,
  seasonalType?: SeasonalType,
  timestamp = 1_000_000,
  phase?: SeasonalPhase,
): Extract<EngineEvent, {type: 'tracker_finished'}> {
  return {
    type:      'tracker_finished',
    timestamp,
    tracker:   {kind, drops, elapsed, active: true, ...(seasonalType ? {seasonalType} : {}), ...(phase ? {phase} : {})},
  };
}

let store: SqliteSessionStore;

beforeEach(() => {
  store = new SqliteSessionStore(openMigratedNodeSqlite());
});

afterEach(() => {
  vi.useRealTimers();
});

function make(meta: Partial<SessionMeta> = {}, readPrices: PriceReader = () => ({})): SessionPersistence {
  return new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false, ...meta}, {store, readPrices});
}

/** Emit the session tracker_finished (the commit point). Defaults save: 60 s, no drops. */
function finish(
  p: SessionPersistence,
  opts: {
    drops?:         Record<number, number>;
    elapsed?:       number;
    dropsBySource?: Partial<Record<Source, Record<number, number>>>;
    sessionMeta?:   {mapTime: number; mapCount: number} | null;
  } = {},
) {
  const event = trackerFinished('session', opts.drops ?? {}, opts.elapsed ?? 60_000);
  if (opts.dropsBySource) event.tracker.dropsBySource = opts.dropsBySource as Record<Source, Record<number, number>>;
  if (opts.sessionMeta !== null) event.sessionMeta = opts.sessionMeta ?? {mapTime: 50_000, mapCount: 1};
  return p.onTrackerFinished(event, makeEngine({hasMap: false}));
}

const rows = (sessionId = 's1') => store.getRows(sessionId);

describe('SessionPersistence.onTrackerFinished — row routing', () => {
  it('saves a map tracker_finished as a primary map row (mapIndex=1)', () => {
    const p = make();
    const engine = makeEngine({hasMap: true, spends: {'42': 3}});

    p.onTrackerFinished(trackerFinished('map', {100: 5}, 60_000), engine);
    expect(rows()).toEqual([]);   // nothing in the DB before the session event
    finish(p);

    expect(rows()).toEqual([{
      sessionId:      's1',
      mapIndex:       1,
      startedAt:      1_000_000 - 60_000,
      duration:       60_000,
      drops:          {'100': 5},
      spent:          {'42': 3},
      seasonalType:   null,
      parentMapIndex: null,
      phase:          null,
    }]);
  });

  it('saves a standalone seasonal (no active map) as a primary row', () => {
    const p = make();

    p.onTrackerFinished(trackerFinished('seasonal', {200: 1}, 30_000, 'sandlord'), makeEngine({hasMap: false}));
    finish(p);

    const saved = rows();
    expect(saved.length).toBe(1);
    expect(saved[0]).toMatchObject({
      mapIndex:       1,
      drops:          {'200': 1},
      seasonalType:   'sandlord',
      parentMapIndex: null,
    });
  });

  it('a standalone seasonal keeps its entry cost (no map row exists to carry it)', () => {
    const p = make();

    p.onTrackerFinished(trackerFinished('seasonal', {200: 1}, 30_000, 'sandlord'), makeEngine({hasMap: false, spends: {'42': 2}}));
    finish(p);

    expect(rows()[0].spent).toEqual({'42': 2});
  });

  it('an overlap seasonal records no spend — its parent map row owns the cost', () => {
    const p = make();
    const engine = makeEngine({hasMap: true, spends: {'42': 2}});

    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), engine);
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), engine);
    finish(p);

    const saved   = rows();
    const map     = saved.find(r => r.seasonalType === null)!;
    const overlap = saved.find(r => r.seasonalType === 'overrealm')!;
    expect(map.spent).toEqual({'42': 2});
    expect(overlap.spent).toEqual({});
  });

  it('saves an overlap seasonal (active map) pointing at the parent mapIndex', () => {
    const p = make();

    // finishAll() emits the seasonal first, while the map tracker is still live.
    p.onTrackerFinished(trackerFinished('seasonal', {300: 2}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 5}, 60_000), makeEngine({hasMap: true}));
    finish(p);

    const saved = rows();
    expect(saved.length).toBe(2);
    expect(saved.find(r => r.seasonalType === null)).toMatchObject({
      mapIndex: 1, parentMapIndex: null,
    });
    expect(saved.find(r => r.seasonalType === 'overrealm')).toMatchObject({
      mapIndex:       1,
      drops:          {'300': 2},
      parentMapIndex: 1,
    });
  });

  it('mapIndex only advances on primary rows (overlap rows reuse parent mapIndex)', () => {
    const p = make();

    // map #1 (bare), then map #2 with an overlap, then a standalone Sandlord.
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 2}, 70_000), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('seasonal', {500: 1}, 90_000, 'sandlord'), makeEngine({hasMap: false}));
    finish(p);

    expect(rows().map(r => ({mi: r.mapIndex, st: r.seasonalType, p: r.parentMapIndex}))).toEqual([
      {mi: 1, st: null,        p: null},
      {mi: 2, st: null,        p: null},
      {mi: 2, st: 'overrealm', p: 2},
      {mi: 3, st: 'sandlord',  p: null},
    ]);
  });

  it("carries a snapshot's phase onto the saved row (in-map sandlord)", () => {
    const p = make();

    // The in-map coin tile finishes first, then the map it ran in.
    p.onTrackerFinished(
      trackerFinished('seasonal', {200: 4}, 15_000, 'sandlord', 1_000_000, 'map'),
      makeEngine({hasMap: true}),
    );
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    finish(p);

    const saved = rows();
    expect(saved.find(r => r.seasonalType === null)!.phase).toBe(null);
    expect(saved.find(r => r.seasonalType === 'sandlord')).toMatchObject({
      mapIndex:       1,
      parentMapIndex: 1,
      phase:          'map',
    });
  });

  it("carries phase 'hub' onto a standalone sandlord row", () => {
    const p = make();

    p.onTrackerFinished(
      trackerFinished('seasonal', {200: 1}, 30_000, 'sandlord', 1_000_000, 'hub'),
      makeEngine({hasMap: false}),
    );
    finish(p);

    expect(rows()[0]).toMatchObject({
      mapIndex:       1,
      seasonalType:   'sandlord',
      parentMapIndex: null,
      phase:          'hub',
    });
  });

  it('a snapshot without phase saves phase null (non-sandlord seasonals, map rows)', () => {
    const p = make();

    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    finish(p);

    expect(rows().map(r => r.phase)).toEqual([null, null]);
  });

  // ZoneHandler's town path calls registry.finishAll(), which finishes every
  // seasonal BEFORE the map tracker. So for an in-map mechanic the seasonal's
  // tracker_finished always arrives while `_lastPrimaryMapIndex` still names the
  // PREVIOUS map — the map it actually ran in has not been buffered yet.
  it('attaches an in-map seasonal to the map it ran in, not the previous one', () => {
    const p = make();
    const engine = makeEngine({hasMap: true});

    // Map 1 completes cleanly, no seasonals.
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), engine);
    // Map 2 runs a Hunting arena. finishAll() emits the seasonal first.
    p.onTrackerFinished(trackerFinished('seasonal', {10054: 2}, 5_000, 'hunting'), engine);
    p.onTrackerFinished(trackerFinished('map', {10054: 2}, 60_000), engine);
    finish(p);

    const saved   = rows();
    const hunting = saved.find(r => r.seasonalType === 'hunting')!;
    const mapTwo  = saved.filter(r => r.seasonalType === null)[1];

    // The hunting run's loot is in map 2's row, so it must point at map 2.
    expect(mapTwo.drops['10054']).toBe(2);
    expect(hunting.parentMapIndex).toBe(mapTwo.mapIndex);
  });

  it('discard() drops staged overlaps whose parent map never arrived', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));

    p.discard();
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    finish(p);

    // The discarded overlap must not resurface when the next map row lands.
    const saved = rows();
    expect(saved.length).toBe(1);
    expect(saved[0].seasonalType).toBe(null);
  });

  it('discard() resets pending rows and primary-index counter', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));

    p.discard();

    // Next map after discard should start back at mapIndex=1.
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    finish(p);
    expect(rows().map(r => r.mapIndex)).toEqual([1]);
  });
});

describe('SessionPersistence — auto-save', () => {
  it('saves a new session with a generated name and drop-through attribution', () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 9, 26, 14, 5));
    const p = make();

    const outcome = finish(p, {
      drops:         {100: 3, 200: 1},
      elapsed:       90_000,
      dropsBySource: {map: {100: 3}, overrealm: {200: 1}},
      sessionMeta:   {mapTime: 75_000, mapCount: 2},
    });

    expect(outcome).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toEqual<DbSession>({
      id:            's1',
      name:          'Session - Oct 26, 2026 14:05',
      savedAt:       new Date(2026, 9, 26, 14, 5).toISOString(),
      totalTime:     90,
      mapTime:       75,
      mapCount:      2,
      drops:         {'100': 3, '200': 1},
      dropsBySource: {map: {'100': 3}, overrealm: {'200': 1}},
      attribution:   'drop-through',
      priceSnapshot: {},
    });
  });

  it('continue: keeps the stored name, overwrites totals, appends rows (mapIndex restarts at 1)', () => {
    store.insertSession({
      id: 's1', name: 'My Run', savedAt: '2026-10-01T00:00:00.000Z', totalTime: 100, mapTime: 80, mapCount: 2,
      drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {'100': 9},
    });
    store.insertRows([
      {sessionId: 's1', mapIndex: 1, startedAt: 1, duration: 1, drops: {'100': 1}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null},
      {sessionId: 's1', mapIndex: 2, startedAt: 2, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null},
    ]);
    const p = make({sessionName: 'My Run', isOverride: true}, () => ({'200': 4}));
    // Renamed while the continued run is in progress — Stop must not revert it.
    store.renameSession('s1', 'Renamed');

    p.onTrackerFinished(trackerFinished('map', {200: 2}, 60_000), makeEngine({hasMap: true}));
    finish(p, {drops: {200: 2}, elapsed: 160_000, dropsBySource: {map: {200: 2}}, sessionMeta: {mapTime: 140_000, mapCount: 3}});

    // Known continue defects (fixed in 2.1), pinned as-is: dropsBySource holds
    // only the new run, the snapshot is replaced, and mapIndex restarts at 1.
    expect(store.getSession('s1')).toMatchObject({
      name:          'Renamed',
      totalTime:     160,
      mapTime:       140,
      mapCount:      3,
      drops:         {'200': 2},
      dropsBySource: {map: {'200': 2}},
      priceSnapshot: {'200': 4},
    });
    expect(rows().map(r => r.mapIndex)).toEqual([1, 2, 1]);
    expect(store.listSessions()).toHaveLength(1);
  });

  it('snapshots prices from the injected reader, spent-only ids included, zero prices skipped', () => {
    const readPrices = vi.fn<PriceReader>(() => ({'100': 5, '42': 2, '300': 0, '999': 7}));
    const p = make({}, readPrices);

    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true, spends: {'42': 3}}));
    finish(p, {drops: {100: 1, 300: 1}});

    expect(readPrices).toHaveBeenCalledTimes(1);
    expect([...readPrices.mock.calls[0][0]].sort()).toEqual(['100', '300', '42']);
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 5, '42': 2});
  });

  it('does not read prices when the session touched no items', () => {
    const readPrices = vi.fn<PriceReader>(() => ({}));
    finish(make({}, readPrices));
    expect(readPrices).not.toHaveBeenCalled();
    expect(store.getSession('s1')?.priceSnapshot).toEqual({});
  });

  it('discards a run under 30 s with no drops, rows included', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {}, 20_000), makeEngine({hasMap: true}));

    expect(finish(p, {elapsed: 29_999})).toEqual({savedId: null});
    expect(store.getSession('s1')).toBeNull();
    expect(rows()).toEqual([]);
  });

  it('saves a run of exactly 30 s with no drops', () => {
    expect(finish(make(), {elapsed: 30_000})).toEqual({savedId: 's1'});
    expect(store.getSession('s1')?.totalTime).toBe(30);
  });

  it('saves a 0 s run that has drops', () => {
    expect(finish(make(), {elapsed: 0, drops: {100: 1}})).toEqual({savedId: 's1'});
    expect(store.getSession('s1')?.drops).toEqual({'100': 1});
  });

  it('saves nothing without sessionMeta', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));

    expect(finish(p, {drops: {100: 1}, sessionMeta: null})).toEqual({savedId: null});
    expect(store.listSessions()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('a session ending mid-map promotes staged overlaps to standalone rows', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    // Map 2 is still running when the session ends; its overlap never gets a parent.
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    finish(p);

    expect(rows().map(r => ({mi: r.mapIndex, st: r.seasonalType, p: r.parentMapIndex, d: r.drops}))).toEqual([
      {mi: 1, st: null,        p: null, d: {'100': 1}},
      {mi: 2, st: 'overrealm', p: null, d: {'300': 1}},
    ]);
  });

  it('clears the buffer and index after a saved session event', () => {
    store.insertSession({
      id: 's1', name: 'Run', savedAt: 'x', totalTime: 0, mapTime: 0, mapCount: 0,
      drops: {}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {},
    });
    const p = make({sessionName: 'Run', isOverride: true});
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    finish(p);

    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    finish(p);

    // Rows from the first commit are not written twice; the index restarts.
    expect(rows().map(r => r.mapIndex)).toEqual([1, 2, 1]);
  });

  it('clears the buffer and index after a discarded session event', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {}, 10_000), makeEngine({hasMap: true}));
    finish(p, {elapsed: 10_000});   // too short — discarded

    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    finish(p);

    expect(rows().map(r => ({mi: r.mapIndex, d: r.drops}))).toEqual([{mi: 1, d: {'100': 1}}]);
  });

  it('writes the session and its rows atomically', () => {
    const p = make();
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    vi.spyOn(store, 'insertRows').mockImplementation(() => { throw new Error('disk full'); });

    expect(() => finish(p)).toThrow('disk full');
    expect(store.getSession('s1')).toBeNull();
  });
});
