/**
 * Persistence of the entry cost, fed through `onEngineEvent` with unit events.
 *
 * The row `spent` comes from the unit's own tracker snapshot
 * (`TrackerSnapshot.spent`, string keys on the row) — the map's entry cost —
 * and is empty for every overlap and standalone seasonal; the session record
 * carries `DbSession.spent` from the session snapshot.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {PriceReader, SessionPersistence} from '@/main/session-persistence';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {SeasonalType} from '@/shared/contracts/engine';
import type {DbSession} from '@/shared/contracts/db';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {checkpointOf, makePersistence, onEngineEvent, sessionFinished, sessionStarted, snap, unitFinished} from '@/test/unit-events';

/** A map unit; `overlap` rides inside it. */
function mapUnit(opts: {drops?: Record<number, number>; spent?: Record<number, number>; overlap?: SeasonalType} = {}) {
  return unitFinished(
    snap('map', opts.drops ?? {}, 60_000, {spent: opts.spent}),
    opts.overlap ? [{tracker: snap('seasonal', {300: 1}, 20_000, {seasonalType: opts.overlap})}] : [],
  );
}

const sessionSpent = (s: DbSession | null) => (s as (DbSession & {spent?: Record<string, number>}) | null)?.spent;

let store: SqliteSessionStore;

beforeEach(() => {
  store = new SqliteSessionStore(openMigratedNodeSqlite());
});

/** A persistence whose session start was already fed (fresh insert, or reopen when continued). */
function make(meta: Parameters<typeof makePersistence>[1] = {}, readPrices: PriceReader = () => ({})): SessionPersistence {
  const p = makePersistence({store, readPrices}, meta);
  onEngineEvent(p, sessionStarted({continued: meta.continued ?? false}));
  return p;
}

function finish(p: SessionPersistence, spent?: Record<number, number>, drops: Record<number, number> = {}) {
  return onEngineEvent(p, sessionFinished({drops, spent}));
}

describe('row spent comes from the finished tracker', () => {
  it('a map row stores the snapshot spent with string keys', () => {
    const p = make();
    onEngineEvent(p, mapUnit({drops: {200: 5}, spent: {100: 3, 300: 2}}));
    finish(p);

    expect(store.getRows('s1')[0].spent).toEqual({'100': 3, '300': 2});
  });

  it('a map without cost stores {}', () => {
    const p = make();
    onEngineEvent(p, mapUnit({drops: {200: 5}}));
    finish(p);

    expect(store.getRows('s1')[0].spent).toEqual({});
  });

  it('a standalone seasonal row is {}', () => {
    const p = make();
    onEngineEvent(p, unitFinished(snap('seasonal', {200: 1}, 60_000, {seasonalType: 'sandlord'})));
    finish(p);

    const [row] = store.getRows('s1');
    expect(row).toMatchObject({seasonalType: 'sandlord', parentMapIndex: null});
    expect(row.spent).toEqual({});
  });

  it('an overlap seasonal row is {} while its parent map row carries the cost', () => {
    const p = make();
    onEngineEvent(p, mapUnit({drops: {200: 1}, spent: {100: 3}, overlap: 'overrealm'}));
    finish(p);

    const saved = store.getRows('s1');
    expect(saved.find(r => r.seasonalType === null)!.spent).toEqual({'100': 3});
    expect(saved.find(r => r.seasonalType === 'overrealm')!.spent).toEqual({});
  });

  it('two maps each keep their own cost', () => {
    const p = make();
    onEngineEvent(p, mapUnit({spent: {100: 3}}));
    onEngineEvent(p, mapUnit({spent: {100: 1, 300: 2}}));
    finish(p);

    expect(store.getRows('s1').map(r => r.spent)).toEqual([{'100': 3}, {'100': 1, '300': 2}]);
  });
});

describe('session spent', () => {
  it('is saved from the session snapshot and round-trips through the store', () => {
    const p = make();
    onEngineEvent(p, mapUnit({spent: {100: 3}}));
    finish(p, {100: 4, 300: 2});

    expect(sessionSpent(store.getSession('s1'))).toEqual({'100': 4, '300': 2});
    expect(sessionSpent(store.listSessions()[0])).toEqual({'100': 4, '300': 2});
  });

  it('is {} when the session spent nothing', () => {
    const p = make();
    finish(p, undefined, {200: 1});
    expect(sessionSpent(store.getSession('s1'))).toEqual({});
  });

  it('a continued session spent is the seeded spend plus the new run spend (the checkpoint already carries both)', () => {
    store.insertSession({
      id: 's1', name: 'Run', savedAt: 'x', totalTime: 0, mapTime: 0, mapCount: 0,
      drops: {}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {},
      spent: {'100': 1},
      endedAt: 1,
    } as DbSession);
    expect(sessionSpent(store.getSession('s1'))).toEqual({'100': 1});

    const p = make({continued: true, nextMapIndex: 1});
    // The engine seeded {100: 1}, then the new run spent 6 more of 100 and 2 of 300.
    onEngineEvent(p, unitFinished(snap('map', {200: 1}, 60_000, {spent: {100: 6, 300: 2}}), [], 1_000_000, checkpointOf({drops: {200: 1}, spent: {100: 7, 300: 2}, mapCount: 1})));
    expect(sessionSpent(store.getSession('s1'))).toEqual({'100': 7, '300': 2});

    finish(p, {100: 7, 300: 2}, {200: 1});
    expect(sessionSpent(store.getSession('s1'))).toEqual({'100': 7, '300': 2});
  });

  it('an own key named __proto__ survives the round trip as data', () => {
    store.insertSession({
      id: 'p1', name: 'Run', savedAt: 'x', totalTime: 0, mapTime: 0, mapCount: 0,
      drops: {}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {},
      spent: Object.fromEntries([['__proto__', 2], ['constructor', 1]]),
      endedAt: 1,
    } as DbSession);
    const spent = sessionSpent(store.getSession('p1'))!;
    expect(Object.keys(spent).sort()).toEqual(['__proto__', 'constructor']);
  });
});

describe('price snapshot covers spent ids', () => {
  it('asks the reader for row-spent and session-spent ids even when they never dropped', () => {
    const readPrices = vi.fn<PriceReader>(() => ({'100': 5, '42': 2, '43': 3, '999': 7}));
    const p = make({}, readPrices);

    onEngineEvent(p, mapUnit({drops: {100: 1}, spent: {42: 3}}));
    finish(p, {43: 1}, {100: 1});

    // Once for the unit (100 dropped, 42 only in the row's spent), once at Stop (43 only in the session spent).
    // Never the reader's extra 999.
    expect(readPrices).toHaveBeenCalledTimes(2);
    expect([...readPrices.mock.calls[0][0]].sort()).toEqual(['100', '42']);
    expect([...readPrices.mock.calls[1][0]].sort()).toEqual(['100', '43']);
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
