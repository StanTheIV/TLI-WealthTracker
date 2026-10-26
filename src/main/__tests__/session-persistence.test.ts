/**
 * SessionPersistence over the real SqliteSessionStore (node:sqlite), fed engine
 * events through `onEngineEvent`. The engine builds the saved unit; persistence
 * only turns a `unit_finished` into rows:
 *   unit      -> [primary, ...overlaps]; the primary takes the next mapIndex
 *                (parentMapIndex null), every overlap shares it and points at it.
 *   session   -> commit (autoSave) and return the outcome.
 *   anything else, including the per-tracker `tracker_finished` of a map or a
 *   seasonal -> no-op.
 * Rows are only observable once the session event commits them, so routing
 * tests end with `finish()` and read back through the store.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {SessionPersistence, type PriceReader, type SessionMeta} from '@/main/session-persistence';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {EngineEvent, Source} from '@/shared/contracts/engine';
import type {DbSession} from '@/shared/contracts/db';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {onEngineEvent, snap, unitFinished} from '@/test/unit-events';

function trackerFinished(tracker: ReturnType<typeof snap>, timestamp = 1_000_000): Extract<EngineEvent, {type: 'tracker_finished'}> {
  return {type: 'tracker_finished', timestamp, tracker};
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
    spent?:         Record<number, number>;
    dropsBySource?: Partial<Record<Source, Record<number, number>>>;
    sessionMeta?:   {mapTime: number; mapCount: number} | null;
  } = {},
) {
  const event = trackerFinished(snap('session', opts.drops ?? {}, opts.elapsed ?? 60_000, {spent: opts.spent}));
  if (opts.dropsBySource) event.tracker.dropsBySource = opts.dropsBySource as Record<Source, Record<number, number>>;
  if (opts.sessionMeta !== null) event.sessionMeta = opts.sessionMeta ?? {mapTime: 50_000, mapCount: 1};
  return onEngineEvent(p, event);
}

const rows = (sessionId = 's1') => store.getRows(sessionId);
const shape = () => rows().map(r => ({mi: r.mapIndex, st: r.seasonalType, p: r.parentMapIndex}));

describe('SessionPersistence.onEngineEvent — unit rows', () => {
  it('saves a bare map unit as one primary row (mapIndex=1)', () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('map', {100: 5}, 60_000, {spent: {42: 3}, startedAt: 940_000})));
    expect(rows()).toEqual([]);   // nothing in the DB before the session event
    finish(p);

    expect(rows()).toEqual([{
      sessionId:      's1',
      mapIndex:       1,
      startedAt:      940_000,
      endedAt:        1_000_000,
      duration:       60_000,
      drops:          {'100': 5},
      spent:          {'42': 3},
      seasonalType:   null,
      parentMapIndex: null,
      phase:          null,
    }]);
  });

  it('a unit with N overlaps saves N+1 rows in order; overlaps share the primary index', () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('map', {100: 5}, 60_000), [
      {tracker: snap('seasonal', {300: 2}, 20_000, {seasonalType: 'overrealm'})},
      {tracker: snap('seasonal', {400: 1}, 10_000, {seasonalType: 'lunaria'})},
      {tracker: snap('seasonal', {500: 3}, 5_000,  {seasonalType: 'hunting'})},
    ]));
    finish(p);

    expect(shape()).toEqual([
      {mi: 1, st: null,        p: null},
      {mi: 1, st: 'overrealm', p: 1},
      {mi: 1, st: 'lunaria',   p: 1},
      {mi: 1, st: 'hunting',   p: 1},
    ]);
    expect(rows()[1]).toMatchObject({drops: {'300': 2}, duration: 20_000});
  });

  it('a standalone seasonal unit is a primary row and bumps the index', () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('seasonal', {200: 1}, 30_000, {seasonalType: 'sandlord'})));
    finish(p);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({mapIndex: 1, drops: {'200': 1}, seasonalType: 'sandlord', parentMapIndex: null});
  });

  it('mapIndex advances once per unit and stays contiguous over a mix of units', () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    onEngineEvent(p, unitFinished(snap('map', {100: 2}, 70_000), [
      {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})},
    ]));
    onEngineEvent(p, unitFinished(snap('seasonal', {500: 1}, 90_000, {seasonalType: 'sandlord'})));
    onEngineEvent(p, unitFinished(snap('map', {100: 3}, 50_000), [
      {tracker: snap('seasonal', {600: 1}, 5_000, {seasonalType: 'vorex'})},
      {tracker: snap('seasonal', {700: 1}, 5_000, {seasonalType: 'carjack'})},
    ]));
    onEngineEvent(p, unitFinished(snap('seasonal', {800: 1}, 15_000, {seasonalType: 'arcana'})));
    finish(p);

    expect(shape()).toEqual([
      {mi: 1, st: null,        p: null},
      {mi: 2, st: null,        p: null},
      {mi: 2, st: 'overrealm', p: 2},
      {mi: 3, st: 'sandlord',  p: null},
      {mi: 4, st: null,        p: null},
      {mi: 4, st: 'vorex',     p: 4},
      {mi: 4, st: 'carjack',   p: 4},
      {mi: 5, st: 'arcana',    p: null},
    ]);
  });

  it('every row starts at its OWN snapshot\'s real start, never finish − elapsed; duration stays the elapsed', () => {
    const p = make();

    // Each run froze or went dormant, so finish − elapsed would read late. The
    // arcana (a town panel reopened in the map) really starts before its map.
    onEngineEvent(p, unitFinished(
      snap('map', {100: 1}, 60_000, {startedAt: 700_000}),
      [
        {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'arcana',  startedAt: 650_000}), timestamp: 940_000},
        {tracker: snap('seasonal', {400: 1}, 10_000, {seasonalType: 'lunaria', startedAt: 800_000}), timestamp: 1_000_000},
      ],
      1_000_000,
    ));
    finish(p);

    expect(rows().map(r => [r.startedAt, r.duration])).toEqual([[700_000, 60_000], [650_000, 20_000], [800_000, 10_000]]);
  });

  it('every row ends at its OWN finish: the primary at the unit timestamp, each overlap at its entry timestamp', () => {
    const p = make();

    // None of these is startedAt + duration: each run froze or went dormant.
    onEngineEvent(p, unitFinished(
      snap('map', {100: 1}, 60_000, {startedAt: 700_000}),
      [
        {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'arcana',  startedAt: 650_000}), timestamp: 940_000},
        {tracker: snap('seasonal', {400: 1}, 10_000, {seasonalType: 'lunaria', startedAt: 800_000}), timestamp: 990_000},
      ],
      1_000_000,
    ));
    onEngineEvent(p, unitFinished(snap('seasonal', {500: 1}, 30_000, {seasonalType: 'vorex', startedAt: 1_100_000}), [], 1_200_000));
    finish(p);

    expect(rows().map(r => [r.seasonalType, r.endedAt])).toEqual([
      [null, 1_000_000], ['arcana', 940_000], ['lunaria', 990_000], ['vorex', 1_200_000],
    ]);
  });

  it('an overlap seasonal records no spend — the primary map row owns the cost', () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000, {spent: {42: 2}}), [
      {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})},
    ]));
    finish(p);

    const saved = rows();
    expect(saved[0].spent).toEqual({'42': 2});
    expect(saved[1].spent).toEqual({});
  });

  it('a standalone seasonal has no entry cost', () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('seasonal', {200: 1}, 30_000, {seasonalType: 'sandlord'})));
    finish(p);

    expect(rows()[0].spent).toEqual({});
  });

  it("carries a snapshot's phase onto the saved row (in-map sandlord overlap, standalone hub)", () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [
      {tracker: snap('seasonal', {200: 4}, 15_000, {seasonalType: 'sandlord', phase: 'map'})},
    ]));
    onEngineEvent(p, unitFinished(snap('seasonal', {200: 1}, 30_000, {seasonalType: 'sandlord', phase: 'hub'})));
    finish(p);

    expect(rows().map(r => ({mi: r.mapIndex, p: r.parentMapIndex, phase: r.phase}))).toEqual([
      {mi: 1, p: null, phase: null},
      {mi: 1, p: 1,    phase: 'map'},
      {mi: 2, p: null, phase: 'hub'},
    ]);
  });

  it('a snapshot without phase saves phase null (non-sandlord seasonals, map rows)', () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [
      {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})},
    ]));
    finish(p);

    expect(rows().map(r => r.phase)).toEqual([null, null]);
  });

  it('seasonalType comes from the snapshot: null for the map primary, set for every overlap', () => {
    const p = make();

    onEngineEvent(p, unitFinished(snap('map', {}, 60_000), [
      {tracker: snap('seasonal', {}, 1_000, {seasonalType: 'dream'})},
    ]));
    finish(p);

    expect(rows().map(r => r.seasonalType)).toEqual([null, 'dream']);
  });

  it('the per-tracker tracker_finished of a map or a seasonal buffers nothing — only units do', () => {
    const p = make();

    onEngineEvent(p, trackerFinished(snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})));
    onEngineEvent(p, trackerFinished(snap('map', {100: 1}, 60_000)));
    finish(p);

    expect(rows()).toEqual([]);
  });

  it('events that are not units or the session finish are ignored', () => {
    const p = make();
    expect(onEngineEvent(p, {type: 'session_saved', sessionId: 'x'})).toBeNull();
    expect(onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)))).toBeNull();
  });

  it('discard() resets the pending rows and the primary-index counter', () => {
    const p = make();
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [
      {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})},
    ]));
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));

    p.discard();

    // The next unit after a discard starts back at mapIndex=1, with nothing carried over.
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
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
      spent:         {},
    });
  });

  it('continue: keeps the stored name, overwrites totals, appends rows (mapIndex restarts at 1)', () => {
    store.insertSession({
      id: 's1', name: 'My Run', savedAt: '2026-10-01T00:00:00.000Z', totalTime: 100, mapTime: 80, mapCount: 2,
      drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {'100': 9},
      spent: {},
    });
    store.insertRows([
      {sessionId: 's1', mapIndex: 1, startedAt: 1, endedAt: 2, duration: 1, drops: {'100': 1}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null},
      {sessionId: 's1', mapIndex: 2, startedAt: 2, endedAt: 3, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null},
    ]);
    const p = make({sessionName: 'My Run', isOverride: true}, () => ({'200': 4}));
    // Renamed while the continued run is in progress — Stop must not revert it.
    store.renameSession('s1', 'Renamed');

    onEngineEvent(p, unitFinished(snap('map', {200: 2}, 60_000)));
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

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000, {spent: {42: 3}})));
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
    onEngineEvent(p, unitFinished(snap('map', {}, 20_000)));

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

  it('saves a 0 s run whose only content is an entry cost (it used to arrive as a negative drop)', () => {
    const p = make();
    expect(finish(p, {elapsed: 0, spent: {42: 3}, sessionMeta: {mapTime: 0, mapCount: 1}})).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toMatchObject({drops: {}, spent: {'42': 3}});
  });

  it('saves nothing without sessionMeta', () => {
    const p = make();
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));

    expect(finish(p, {drops: {100: 1}, sessionMeta: null})).toEqual({savedId: null});
    expect(store.listSessions()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('standalone units emitted by a stop (finished children promoted) save like any standalone', () => {
    const p = make();
    // The engine's stop emits each already-finished child as a standalone unit
    // before the session finish; persistence needs no special case.
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    onEngineEvent(p, unitFinished(snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})));
    finish(p);

    expect(rows().map(r => ({mi: r.mapIndex, st: r.seasonalType, p: r.parentMapIndex, d: r.drops}))).toEqual([
      {mi: 1, st: null,        p: null, d: {'100': 1}},
      {mi: 2, st: 'overrealm', p: null, d: {'300': 1}},
    ]);
  });

  it('clears the buffer and index after a saved session event', () => {
    store.insertSession({
      id: 's1', name: 'Run', savedAt: 'x', totalTime: 0, mapTime: 0, mapCount: 0,
      drops: {}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {}, spent: {},
    });
    const p = make({sessionName: 'Run', isOverride: true});
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    finish(p);

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    finish(p);

    // Rows from the first commit are not written twice; the index restarts.
    expect(rows().map(r => r.mapIndex)).toEqual([1, 2, 1]);
  });

  it('clears the buffer and index after a discarded session event', () => {
    const p = make();
    onEngineEvent(p, unitFinished(snap('map', {}, 10_000)));
    finish(p, {elapsed: 10_000});   // too short — discarded

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    finish(p);

    expect(rows().map(r => ({mi: r.mapIndex, d: r.drops}))).toEqual([{mi: 1, d: {'100': 1}}]);
  });

  it('writes the session and its rows atomically', () => {
    const p = make();
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    vi.spyOn(store, 'insertRows').mockImplementation(() => { throw new Error('disk full'); });

    expect(() => finish(p)).toThrow('disk full');
    expect(store.getSession('s1')).toBeNull();
  });
});
