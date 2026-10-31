/**
 * SessionPersistence (per-unit model, step 2.1c) over the real SqliteSessionStore
 * (node:sqlite), fed engine events through `onEngineEvent`:
 *   session tracker_started   -> fresh: insert a live row (endedAt NULL, empty totals);
 *                                continued: reopen the stored row.
 *   unit_finished             -> ONE transaction: the unit's rows (primary = next
 *                                mapIndex, overlaps share it), the session totals
 *                                from `checkpoint`, a merged price snapshot.
 *   session tracker_finished  -> final totals from the snapshot, prices merged,
 *                                row closed at the event time; a run under 30 s
 *                                with no content is deleted instead.
 *   anything else             -> no-op.
 * Every write reports `{savedId}` / `{deletedId}`; the rest is `null`.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {PriceReader, SessionPersistence} from '@/main/session-persistence';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {
  checkpointOf, makePersistence, onEngineEvent, sessionFinished, sessionStarted, snap, unitFinished,
} from '@/test/unit-events';

let store: SqliteSessionStore;

beforeEach(() => {
  store = new SqliteSessionStore(openMigratedNodeSqlite());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function make(meta: Parameters<typeof makePersistence>[1] = {}, readPrices: PriceReader = () => ({})): SessionPersistence {
  return makePersistence({store, readPrices}, meta);
}

/** A fresh persistence whose session row already exists (tracker_started fed). */
function begun(meta: Parameters<typeof makePersistence>[1] = {}, readPrices: PriceReader = () => ({})): SessionPersistence {
  const p = make(meta, readPrices);
  onEngineEvent(p, sessionStarted({sessionId: meta.sessionId ?? 's1', name: meta.name ?? 'Run'}));
  return p;
}

const rows = (sessionId = 's1') => store.getRows(sessionId);
const shape = () => rows().map(r => ({mi: r.mapIndex, st: r.seasonalType, p: r.parentMapIndex}));

/** A closed saved session with two primary rows, as a continue finds it. */
function seedClosed(over: Partial<DbSession> = {}): DbSession {
  const s: DbSession = {
    id: 's1', name: 'My Run', savedAt: '2026-10-01T00:00:00.000Z', totalTime: 100, mapTime: 80, mapCount: 2,
    drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {'100': 9},
    spent: {}, endedAt: Date.parse('2026-10-01T00:00:00.000Z'), ...over,
  };
  store.insertSession(s);
  store.insertRows([
    {sessionId: s.id, mapIndex: 1, startedAt: 1, endedAt: 2, duration: 1, drops: {'100': 1}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null},
    {sessionId: s.id, mapIndex: 2, startedAt: 2, endedAt: 3, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null},
  ]);
  return s;
}

describe('SessionPersistence — session start', () => {
  it('a fresh run inserts a live row at tracker_started: meta name, empty totals, drop-through, endedAt NULL', () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 9, 26, 14, 5));
    const p = make({sessionId: 's1', name: 'Session - Oct 26, 2026 14:05'});

    const outcome = onEngineEvent(p, sessionStarted({sessionId: 's1', name: 'Session - Oct 26, 2026 14:05'}));

    expect(outcome).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toEqual<DbSession>({
      id:            's1',
      name:          'Session - Oct 26, 2026 14:05',
      savedAt:       new Date(2026, 9, 26, 14, 5).toISOString(),
      totalTime:     0,
      mapTime:       0,
      mapCount:      0,
      drops:         {},
      dropsBySource: {},
      attribution:   'drop-through',
      priceSnapshot: {},
      spent:         {},
      endedAt:       null,
    });
    expect(store.listOpenSessions().map(s => s.id)).toEqual(['s1']);
  });

  it('a fresh run on an id that already exists throws and leaves the old row untouched', () => {
    const existing = seedClosed();
    const p = make();
    expect(() => onEngineEvent(p, sessionStarted())).toThrow();
    expect(store.getSession('s1')).toEqual(existing);
  });

  it('a continued run reopens the stored row (endedAt NULL), keeping name and totals; no second row', () => {
    seedClosed();
    const p = make({continued: true, nextMapIndex: 3});

    const outcome = onEngineEvent(p, sessionStarted({continued: true, name: 'My Run', mapTime: 80_000, mapCount: 2}));

    expect(outcome).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toMatchObject({name: 'My Run', totalTime: 100, mapCount: 2, drops: {'100': 1}, endedAt: null});
    expect(store.listSessions()).toHaveLength(1);
    expect(rows()).toHaveLength(2);
  });

  it('the tracker_started of a map or a seasonal inserts nothing', () => {
    const p = make();
    const mapStart: EngineEvent = {type: 'tracker_started', tracker: snap('map', {}, 0), timestamp: 1};
    expect(onEngineEvent(p, mapStart)).toBeNull();
    expect(store.listSessions()).toEqual([]);
  });
});

describe('SessionPersistence — unit rows', () => {
  it('saves a bare map unit as one primary row (mapIndex=1), visible immediately', () => {
    const p = begun();

    onEngineEvent(p, unitFinished(snap('map', {100: 5}, 60_000, {spent: {42: 3}, startedAt: 940_000})));

    expect(rows()).toEqual<DbSessionMap[]>([{
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
    const p = begun();

    onEngineEvent(p, unitFinished(snap('map', {100: 5}, 60_000), [
      {tracker: snap('seasonal', {300: 2}, 20_000, {seasonalType: 'overrealm'})},
      {tracker: snap('seasonal', {400: 1}, 10_000, {seasonalType: 'lunaria'})},
      {tracker: snap('seasonal', {500: 3}, 5_000,  {seasonalType: 'hunting'})},
    ]));

    expect(shape()).toEqual([
      {mi: 1, st: null,        p: null},
      {mi: 1, st: 'overrealm', p: 1},
      {mi: 1, st: 'lunaria',   p: 1},
      {mi: 1, st: 'hunting',   p: 1},
    ]);
    expect(rows()[1]).toMatchObject({drops: {'300': 2}, duration: 20_000});
  });

  it('a standalone seasonal unit is a primary row and bumps the index', () => {
    const p = begun();

    onEngineEvent(p, unitFinished(snap('seasonal', {200: 1}, 30_000, {seasonalType: 'sandlord'})));

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({mapIndex: 1, drops: {'200': 1}, seasonalType: 'sandlord', parentMapIndex: null});
  });

  it('mapIndex advances once per unit and stays contiguous over a mix of units', () => {
    const p = begun();

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

  it('every row starts at its OWN snapshot\'s real start, never finish - elapsed; duration stays the elapsed', () => {
    const p = begun();

    onEngineEvent(p, unitFinished(
      snap('map', {100: 1}, 60_000, {startedAt: 700_000}),
      [
        {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'arcana',  startedAt: 650_000}), timestamp: 940_000},
        {tracker: snap('seasonal', {400: 1}, 10_000, {seasonalType: 'lunaria', startedAt: 800_000}), timestamp: 1_000_000},
      ],
      1_000_000,
    ));

    expect(rows().map(r => [r.startedAt, r.duration])).toEqual([[700_000, 60_000], [650_000, 20_000], [800_000, 10_000]]);
  });

  it('every row ends at its OWN finish: the primary at the unit timestamp, each overlap at its entry timestamp', () => {
    const p = begun();

    onEngineEvent(p, unitFinished(
      snap('map', {100: 1}, 60_000, {startedAt: 700_000}),
      [
        {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'arcana',  startedAt: 650_000}), timestamp: 940_000},
        {tracker: snap('seasonal', {400: 1}, 10_000, {seasonalType: 'lunaria', startedAt: 800_000}), timestamp: 990_000},
      ],
      1_000_000,
    ));
    onEngineEvent(p, unitFinished(snap('seasonal', {500: 1}, 30_000, {seasonalType: 'vorex', startedAt: 1_100_000}), [], 1_200_000));

    expect(rows().map(r => [r.seasonalType, r.endedAt])).toEqual([
      [null, 1_000_000], ['arcana', 940_000], ['lunaria', 990_000], ['vorex', 1_200_000],
    ]);
  });

  it('an overlap seasonal records no spend, the primary map row owns the cost; a standalone seasonal has none', () => {
    const p = begun();

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000, {spent: {42: 2}}), [
      {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})},
    ]));
    onEngineEvent(p, unitFinished(snap('seasonal', {200: 1}, 30_000, {seasonalType: 'sandlord'})));

    expect(rows().map(r => r.spent)).toEqual([{'42': 2}, {}, {}]);
  });

  it("carries a snapshot's phase onto the saved row; map rows and plain seasonals save phase null", () => {
    const p = begun();

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [
      {tracker: snap('seasonal', {200: 4}, 15_000, {seasonalType: 'sandlord', phase: 'map'})},
      {tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})},
    ]));
    onEngineEvent(p, unitFinished(snap('seasonal', {200: 1}, 30_000, {seasonalType: 'sandlord', phase: 'hub'})));

    expect(rows().map(r => ({mi: r.mapIndex, p: r.parentMapIndex, st: r.seasonalType, phase: r.phase}))).toEqual([
      {mi: 1, p: null, st: null,        phase: null},
      {mi: 1, p: 1,    st: 'sandlord',  phase: 'map'},
      {mi: 1, p: 1,    st: 'overrealm', phase: null},
      {mi: 2, p: null, st: 'sandlord',  phase: 'hub'},
    ]);
  });

  it('the per-tracker tracker_finished of a map or a seasonal writes nothing, only units do', () => {
    const p = begun();
    const finished = (tracker: ReturnType<typeof snap>): EngineEvent => ({type: 'tracker_finished', timestamp: 1_000_000, tracker});

    expect(onEngineEvent(p, finished(snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})))).toBeNull();
    expect(onEngineEvent(p, finished(snap('map', {100: 1}, 60_000)))).toBeNull();

    expect(rows()).toEqual([]);
    expect(store.getSession('s1')).toMatchObject({endedAt: null, mapCount: 0});
  });

  it('events that are not session start/finish or units are ignored', () => {
    const p = begun();
    expect(onEngineEvent(p, {type: 'session_saved', sessionId: 'x'})).toBeNull();
    expect(onEngineEvent(p, {type: 'map_ended', elapsed: 1, timestamp: 1})).toBeNull();
  });
});

describe('SessionPersistence — per-unit totals and prices', () => {
  it('a unit returns {savedId} and updates the session from its checkpoint (ms -> s), session still live', () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 9, 26, 14, 30));
    const p = begun();

    const outcome = onEngineEvent(p, unitFinished(snap('map', {100: 3}, 60_000, {spent: {42: 1}}), [], 1_000_000, checkpointOf({
      drops:         {100: 3, 200: 1},
      spent:         {42: 1},
      dropsBySource: {map: {100: 3}, overrealm: {200: 1}},
      elapsed:       90_000,
      mapTime:       75_000,
      mapCount:      2,
    })));

    expect(outcome).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toMatchObject({
      savedAt:       new Date(2026, 9, 26, 14, 30).toISOString(),
      totalTime:     90,
      mapTime:       75,
      mapCount:      2,
      drops:         {'100': 3, '200': 1},
      dropsBySource: {map: {'100': 3}, overrealm: {'200': 1}},
      spent:         {'42': 1},
      attribution:   'drop-through',
      endedAt:       null,
    });
  });

  it('each unit overwrites the totals with its own (later) checkpoint', () => {
    const p = begun();
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}, elapsed: 60_000, mapTime: 55_000, mapCount: 1})));
    onEngineEvent(p, unitFinished(snap('map', {100: 2}, 60_000), [], 1_100_000, checkpointOf({drops: {100: 3}, elapsed: 130_000, mapTime: 115_000, mapCount: 2})));

    expect(store.getSession('s1')).toMatchObject({totalTime: 130, mapTime: 115, mapCount: 2, drops: {'100': 3}});
  });

  it('rows, totals and price merge of a unit commit in ONE transaction', () => {
    const p = begun({}, () => ({'100': 5}));
    const tx = vi.spyOn(store, 'transaction');

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}, mapCount: 1})));

    expect(tx).toHaveBeenCalledTimes(1);
  });

  it('merges prices for the unit\'s drops and spent, its overlaps\' and the checkpoint session\'s ids; zero prices skipped', () => {
    const readPrices = vi.fn<PriceReader>(() => ({'100': 5, '42': 2, '300': 0, '500': 7, '600': 8, '700': 9, '999': 7}));
    const p = begun({}, readPrices);

    onEngineEvent(p, unitFinished(
      snap('map', {100: 1, 300: 1}, 60_000, {spent: {42: 3}}),
      [{tracker: snap('seasonal', {500: 1}, 10_000, {seasonalType: 'overrealm'})}],
      1_000_000,
      checkpointOf({drops: {100: 1, 300: 1, 500: 1, 600: 1}, spent: {42: 3, 700: 1}}),
    ));

    expect(readPrices).toHaveBeenCalledTimes(1);
    expect([...readPrices.mock.calls[0][0]].sort()).toEqual(['100', '300', '42', '500', '600', '700']);
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 5, '42': 2, '500': 7, '600': 8, '700': 9});
  });

  it('the snapshot is merged per unit: earlier keys kept, first price wins, new ids added', () => {
    let price = 5;
    const p = begun({}, ids => Object.fromEntries([...ids].map(id => [id, price])));

    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}})));
    price = 99;
    onEngineEvent(p, unitFinished(snap('map', {200: 1}, 60_000), [], 1_100_000, checkpointOf({drops: {100: 1, 200: 1}})));

    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 5, '200': 99});
  });

  it('does not read prices when the unit and session touched no items', () => {
    const readPrices = vi.fn<PriceReader>(() => ({}));
    const p = begun({}, readPrices);
    onEngineEvent(p, unitFinished(snap('map', {}, 60_000)));
    expect(readPrices).not.toHaveBeenCalled();
  });
});

describe('SessionPersistence — failed unit write', () => {
  it('a unit whose insertRows throws leaves the earlier units intact and does NOT advance the index', () => {
    const p = begun();
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}, mapCount: 1})));
    const spy = vi.spyOn(store, 'insertRows').mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => onEngineEvent(p, unitFinished(snap('map', {200: 1}, 60_000), [], 1_100_000, checkpointOf({drops: {100: 1, 200: 1}, mapCount: 2})))).toThrow('disk full');

    spy.mockRestore();
    expect(shape()).toEqual([{mi: 1, st: null, p: null}]);
    expect(store.getSession('s1')).toMatchObject({drops: {'100': 1}, mapCount: 1});   // the failed unit's totals rolled back

    // The next unit reuses index 2 (a skipped one would leave a hole).
    onEngineEvent(p, unitFinished(snap('map', {300: 1}, 60_000), [], 1_200_000, checkpointOf({drops: {100: 1, 300: 1}, mapCount: 3})));
    expect(shape()).toEqual([{mi: 1, st: null, p: null}, {mi: 2, st: null, p: null}]);
    expect(rows()[1].drops).toEqual({'300': 1});
  });

  it('a failure after the rows were written (price merge) rolls the rows back too', () => {
    const p = begun({}, () => ({'100': 5}));
    vi.spyOn(store, 'mergePriceSnapshot').mockImplementationOnce(() => { throw new Error('merge boom'); });

    expect(() => onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}})))).toThrow('merge boom');

    expect(rows()).toEqual([]);
    expect(store.getSession('s1')).toMatchObject({totalTime: 0, drops: {}});
  });

  it('a throwing price reader aborts the unit before anything is written', () => {
    const p = begun({}, () => { throw new Error('items down'); });
    expect(() => onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}})))).toThrow('items down');
    expect(rows()).toEqual([]);
  });

  it('a unit for a session that vanished throws inside the transaction: no orphan rows', () => {
    const p = begun();
    store.deleteSession('s1');

    expect(() => onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}})))).toThrow();

    expect(store.getSession('s1')).toBeNull();
    expect(rows()).toEqual([]);
  });
});

describe('SessionPersistence — Stop', () => {
  it('writes the final totals from the session snapshot + sessionMeta, closes the row at the event time', () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 9, 26, 15, 0));
    const p = begun();
    onEngineEvent(p, unitFinished(snap('map', {100: 3}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 3}, elapsed: 60_000, mapTime: 55_000, mapCount: 1})));

    const outcome = onEngineEvent(p, sessionFinished({
      drops: {100: 3, 200: 1}, spent: {42: 2}, dropsBySource: {map: {100: 3}, overrealm: {200: 1}},
      elapsed: 90_000, mapTime: 75_000, mapCount: 2, timestamp: 2_000_000,
    }));

    expect(outcome).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toMatchObject({
      savedAt:       new Date(2026, 9, 26, 15, 0).toISOString(),
      totalTime:     90,
      mapTime:       75,
      mapCount:      2,
      drops:         {'100': 3, '200': 1},
      dropsBySource: {map: {'100': 3}, overrealm: {'200': 1}},
      spent:         {'42': 2},
      attribution:   'drop-through',
      endedAt:       2_000_000,
    });
    expect(store.listOpenSessions()).toEqual([]);
  });

  it('merges the session\'s drop and spent ids into the snapshot (old keys kept, zero prices skipped)', () => {
    const readPrices = vi.fn<PriceReader>(() => ({'100': 5, '42': 2, '300': 0, '999': 7}));
    const p = begun({}, readPrices);
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}})));
    readPrices.mockClear();
    readPrices.mockImplementation(() => ({'100': 50, '42': 2, '300': 0, '999': 7}));

    onEngineEvent(p, sessionFinished({drops: {100: 1, 300: 1}, spent: {42: 3}}));

    expect([...readPrices.mock.calls[0][0]].sort()).toEqual(['100', '300', '42']);
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 5, '42': 2});
  });

  it('a continued Stop keeps the stored price keys and adds the new ones', () => {
    seedClosed();
    const p = make({continued: true, nextMapIndex: 3}, () => ({'200': 4}));
    onEngineEvent(p, sessionStarted({continued: true, name: 'My Run'}));

    onEngineEvent(p, sessionFinished({drops: {100: 1, 200: 2}, elapsed: 160_000}));

    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 9, '200': 4});
  });

  it('Stop leaves a rename done while tracking alone', () => {
    const p = begun();
    store.renameSession('s1', 'Renamed');
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1}})));
    onEngineEvent(p, sessionFinished({drops: {100: 1}}));
    expect(store.getSession('s1')?.name).toBe('Renamed');
  });

  it('deletes a run under 30 s with no drops, no spent and no rows -> {deletedId}', () => {
    const p = begun();

    expect(onEngineEvent(p, sessionFinished({elapsed: 29_999, mapCount: 0, mapTime: 0}))).toEqual({deletedId: 's1'});

    expect(store.getSession('s1')).toBeNull();
    expect(rows()).toEqual([]);
  });

  it('keeps a run of exactly 30 s with no drops', () => {
    const p = begun();
    expect(onEngineEvent(p, sessionFinished({elapsed: 30_000}))).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toMatchObject({totalTime: 30, endedAt: 1_000_000});
  });

  it('keeps a 0 s run that has drops', () => {
    const p = begun();
    expect(onEngineEvent(p, sessionFinished({elapsed: 0, drops: {100: 1}}))).toEqual({savedId: 's1'});
    expect(store.getSession('s1')?.drops).toEqual({'100': 1});
  });

  it('keeps a 0 s run whose only content is an entry cost', () => {
    const p = begun();
    expect(onEngineEvent(p, sessionFinished({elapsed: 0, spent: {42: 3}, mapCount: 1, mapTime: 0}))).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toMatchObject({drops: {}, spent: {'42': 3}});
  });

  it('keeps a short run that already saved a row, even with no drops or spend', () => {
    const p = begun();
    onEngineEvent(p, unitFinished(snap('map', {}, 10_000), [], 1_000_000, checkpointOf({elapsed: 10_000, mapTime: 10_000, mapCount: 1})));

    expect(onEngineEvent(p, sessionFinished({elapsed: 10_000, mapTime: 10_000, mapCount: 1}))).toEqual({savedId: 's1'});
    expect(rows()).toHaveLength(1);
    expect(store.getSession('s1')?.endedAt).toBe(1_000_000);
  });

  it('standalone units emitted by a stop (finished children promoted) save like any standalone, before the session finish', () => {
    const p = begun();
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    onEngineEvent(p, unitFinished(snap('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'})));
    onEngineEvent(p, sessionFinished({drops: {100: 1, 300: 1}}));

    expect(rows().map(r => ({mi: r.mapIndex, st: r.seasonalType, p: r.parentMapIndex, d: r.drops}))).toEqual([
      {mi: 1, st: null,        p: null, d: {'100': 1}},
      {mi: 2, st: 'overrealm', p: null, d: {'300': 1}},
    ]);
  });
});

describe('SessionPersistence — continued run', () => {
  it('indexes continue from nextMapIndex; overlaps share the continued primary index', () => {
    seedClosed();
    const p = make({continued: true, nextMapIndex: 3});
    onEngineEvent(p, sessionStarted({continued: true, name: 'My Run'}));

    onEngineEvent(p, unitFinished(snap('map', {200: 2}, 60_000), [
      {tracker: snap('seasonal', {300: 1}, 10_000, {seasonalType: 'overrealm'})},
    ]));
    onEngineEvent(p, unitFinished(snap('map', {200: 1}, 60_000)));

    expect(rows().map(r => [r.mapIndex, r.parentMapIndex])).toEqual([[1, null], [2, null], [3, null], [3, 3], [4, null]]);
  });

  it('totals are the checkpoint as is: it already contains the seeded values, nothing is added on top', () => {
    seedClosed();
    const p = make({continued: true, nextMapIndex: 3});
    onEngineEvent(p, sessionStarted({continued: true, name: 'My Run'}));

    onEngineEvent(p, unitFinished(snap('map', {200: 2}, 60_000), [], 1_000_000, checkpointOf({
      drops: {100: 1, 200: 2}, dropsBySource: {map: {100: 1, 200: 2}}, spent: {7: 1},
      elapsed: 160_000, mapTime: 140_000, mapCount: 3,
    })));

    expect(store.getSession('s1')).toMatchObject({
      name:          'My Run',
      totalTime:     160,
      mapTime:       140,
      mapCount:      3,
      drops:         {'100': 1, '200': 2},
      dropsBySource: {map: {'100': 1, '200': 2}},
      spent:         {'7': 1},
      endedAt:       null,
    });
  });

  it('the price snapshot is merged: old keys kept, first price wins', () => {
    seedClosed({priceSnapshot: {'100': 9}});
    const p = make({continued: true, nextMapIndex: 3}, () => ({'100': 1, '200': 4}));
    onEngineEvent(p, sessionStarted({continued: true, name: 'My Run'}));

    onEngineEvent(p, unitFinished(snap('map', {200: 2}, 60_000), [], 1_000_000, checkpointOf({drops: {100: 1, 200: 2}})));

    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 9, '200': 4});
  });

  it('a continued short run with earlier rows is kept at Stop (rows exist)', () => {
    seedClosed();
    const p = make({continued: true, nextMapIndex: 3});
    onEngineEvent(p, sessionStarted({continued: true, name: 'My Run'}));

    expect(onEngineEvent(p, sessionFinished({elapsed: 10_000, mapCount: 2, mapTime: 0}))).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).not.toBeNull();
    expect(rows()).toHaveLength(2);
  });
});

describe('SessionPersistence — independence', () => {
  it('two persistences sharing a store write independent sessions', () => {
    const a = begun({sessionId: 'A'});
    const b = begun({sessionId: 'B'});
    onEngineEvent(a, unitFinished(snap('map', {1: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {1: 1}})));
    onEngineEvent(b, unitFinished(snap('map', {2: 1}, 60_000), [], 1_000_000, checkpointOf({drops: {2: 1}})));

    expect(store.getRows('A')).toHaveLength(1);
    expect(store.getRows('B')).toHaveLength(1);
    expect(store.getRows('A')[0].drops).toEqual({'1': 1});
    expect(store.getSession('B')?.drops).toEqual({'2': 1});
  });
});
