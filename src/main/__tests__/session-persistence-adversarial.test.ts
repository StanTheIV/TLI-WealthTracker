/**
 * Adversarial cases for the per-unit SessionPersistence over the real store:
 * a real constraint failure inside a unit transaction, price filtering, name and
 * end-time ownership between writers.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {PriceReader} from '@/main/session-persistence';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {DbSession} from '@/shared/contracts/db';
import type {SqlConn} from '@/main/db/sql-conn';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {
  checkpointOf, makePersistence, onEngineEvent, sessionFinished, sessionStarted, snap, unitFinished,
} from '@/test/unit-events';

let conn: SqlConn;
let store: SqliteSessionStore;
beforeEach(() => { conn = openMigratedNodeSqlite(); store = new SqliteSessionStore(conn); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const make = (meta: Parameters<typeof makePersistence>[1] = {}, readPrices: PriceReader = () => ({})) => {
  const p = makePersistence({store, readPrices}, meta);
  if (!meta.continued) onEngineEvent(p, sessionStarted({sessionId: meta.sessionId ?? 's1'}));
  return p;
};

/** A map unit whose checkpoint carries the session drops/spent. */
const mapUnit = (
  drops: Record<number, number>, elapsed: number, opts: {spent?: Record<number, number>; session?: Record<number, number>} = {},
) => unitFinished(
  snap('map', drops, elapsed, {spent: opts.spent}), [], 1_000_000,
  checkpointOf({drops: opts.session ?? drops, spent: opts.spent, elapsed, mapCount: 1}),
);

const existing: DbSession = {
  id: 's1', name: 'My Run', savedAt: '2026-10-01T00:00:00.000Z', totalTime: 100, mapTime: 80, mapCount: 2,
  drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {'100': 9},
  spent: {}, endedAt: Date.parse('2026-10-01T00:00:00.000Z'),
};

describe('atomicity', () => {
  it('a real constraint failure in a row (NOT NULL started_at) rolls the whole unit back and keeps the index', () => {
    const p = make();
    const bad = mapUnit({100: 1}, 60_000);
    (bad.tracker as {startedAt: unknown}).startedAt = null;

    expect(() => onEngineEvent(p, bad)).toThrow();
    expect(store.getRows('s1')).toEqual([]);
    expect(store.getSession('s1')).toMatchObject({drops: {}, totalTime: 0});

    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    expect(store.getRows('s1').map(r => r.mapIndex)).toEqual([1]);
  });

  it('a unit failing mid-overlap leaves no partial unit (primary row rolled back with it)', () => {
    const p = make();
    const bad = unitFinished(snap('map', {100: 1}, 60_000), [
      {tracker: snap('seasonal', {300: 1}, 10_000, {seasonalType: 'overrealm'})},
    ]);
    (bad.overlaps[0].tracker as {startedAt: unknown}).startedAt = null;

    expect(() => onEngineEvent(p, bad)).toThrow();
    expect(store.getRows('s1')).toEqual([]);
  });

  it('a failing final write does not close the row', () => {
    const p = make();
    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    vi.spyOn(store, 'closeSession').mockImplementationOnce(() => { throw new Error('close boom'); });

    expect(() => onEngineEvent(p, sessionFinished({drops: {100: 1}}))).toThrow('close boom');

    expect(store.getSession('s1')?.endedAt).toBeNull();
    expect(store.getRows('s1')).toHaveLength(1);
  });
});

describe('price capture filtering', () => {
  it('ids the reader returns but were not requested are dropped', () => {
    const p = make({}, () => ({'100': 5, '777': 3}));
    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 5});
  });

  it('negative, NaN and zero prices are skipped; fractional kept', () => {
    const p = make({}, () => ({'1': -1, '2': NaN, '3': 0, '4': 0.001}));
    onEngineEvent(p, mapUnit({1: 1, 2: 1, 3: 1, 4: 1}, 60_000));
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'4': 0.001});
  });

  it('needed ids include the map\'s spent, the checkpoint session\'s spent and drops; a standalone seasonal adds none of its own', () => {
    const reader = vi.fn<PriceReader>(() => ({}));
    const p = make({}, reader);
    onEngineEvent(p, unitFinished(snap('map', {}, 60_000, {spent: {11: 1}}), [], 1_000_000, checkpointOf({spent: {11: 1, 22: 1}, drops: {33: 1}})));
    expect([...reader.mock.calls[0][0]].sort()).toEqual(['11', '22', '33']);

    reader.mockClear();
    onEngineEvent(p, unitFinished(snap('seasonal', {}, 60_000, {seasonalType: 'sandlord'})));
    expect(reader).not.toHaveBeenCalled();
  });

  it('a throwing reader at Stop aborts the final write: the row stays live', () => {
    let boom = false;
    const p = make({}, () => { if (boom) throw new Error('items down'); return {}; });
    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    boom = true;

    expect(() => onEngineEvent(p, sessionFinished({drops: {100: 1}}))).toThrow('items down');
    expect(store.getSession('s1')?.endedAt).toBeNull();
  });

  it('prototype-ish item ids are plain keys in the merged snapshot', () => {
    const p = make({}, ids => Object.fromEntries([...ids].map(id => [id, 2])));
    onEngineEvent(p, mapUnit({100: 1}, 60_000, {session: {100: 1}}));
    onEngineEvent(p, unitFinished(snap('map', {}, 60_000), [], 1_100_000, checkpointOf({drops: Object.fromEntries([['__proto__', 1]]) as Record<number, number>})));
    expect(Object.keys(store.getSession('s1')!.priceSnapshot).sort()).toEqual(['100', '__proto__']);
  });
});

describe('misc persistence', () => {
  it('a checkpoint session without dropsBySource saves {}; number keys become string keys', () => {
    const p = make();
    onEngineEvent(p, mapUnit({100: 2}, 60_000));
    expect(store.getSession('s1')).toMatchObject({dropsBySource: {}, drops: {'100': 2}, attribution: 'drop-through'});
  });

  it('a rename through a second store handle survives every later write', () => {
    store.insertSession(existing);
    const p = make({continued: true, nextMapIndex: 1});
    onEngineEvent(p, sessionStarted({continued: true, name: 'My Run'}));
    new SqliteSessionStore(conn).renameSession('s1', 'Other');

    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    expect(store.getSession('s1')?.name).toBe('Other');
    onEngineEvent(p, sessionFinished({drops: {100: 1}}));
    expect(store.getSession('s1')?.name).toBe('Other');
  });

  it('a session deleted while tracking (Reset) makes its stale persistence throw, never resurrect rows or a row', () => {
    const p = make();
    store.deleteSession('s1');

    expect(() => onEngineEvent(p, mapUnit({100: 1}, 60_000))).toThrow();

    expect(store.listSessions()).toEqual([]);
    expect(store.getRows('s1')).toEqual([]);
  });

  it('continued reopen then immediate Stop with nothing new: closed again at the event time, row set intact', () => {
    store.insertSession(existing);
    store.insertRows([{sessionId: 's1', mapIndex: 1, startedAt: 1, endedAt: 2, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null}]);
    const p = make({continued: true, nextMapIndex: 2});
    onEngineEvent(p, sessionStarted({continued: true, name: 'My Run'}));
    expect(store.getSession('s1')?.endedAt).toBeNull();

    onEngineEvent(p, sessionFinished({drops: {100: 1}, elapsed: 100_000, mapCount: 2, timestamp: 5_000_000}));

    expect(store.getSession('s1')).toMatchObject({endedAt: 5_000_000, drops: {'100': 1}});
    expect(store.getRows('s1')).toHaveLength(1);
  });

  it('two persistences sharing a store write independent sessions', () => {
    const a = make({sessionId: 'A'});
    const b = make({sessionId: 'B'});
    onEngineEvent(a, mapUnit({1: 1}, 60_000));
    onEngineEvent(b, mapUnit({2: 1}, 60_000));
    expect(store.getRows('A')).toHaveLength(1);
    expect(store.getRows('B')[0].drops).toEqual({'2': 1});
  });
});
