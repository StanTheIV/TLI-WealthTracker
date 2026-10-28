/**
 * Adversarial cases for SessionPersistence over the real store, fed through
 * `onEngineEvent` with hand-built units: atomicity on both branches, buffer
 * state after a failed save, price filtering.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {SessionPersistence, type PriceReader, type SessionMeta} from '@/main/session-persistence';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {DbSession} from '@/shared/contracts/db';
import type {SqlConn} from '@/main/db/sql-conn';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {onEngineEvent, snap, unitFinished} from '@/test/unit-events';

/** A map unit (no overlaps) with the given drops, spend and duration. */
const mapUnit = (drops: Record<number, number>, elapsed: number, spent?: Record<number, number>) =>
  unitFinished(snap('map', drops, elapsed, {spent}));

function sessionFinished(drops: Record<number, number>, elapsed: number, spent?: Record<number, number>) {
  const e: Extract<EngineEvent, {type: 'tracker_finished'}> = {
    type: 'tracker_finished', timestamp: 1_000_000, tracker: snap('session', drops, elapsed, {spent}),
  };
  e.sessionMeta = {mapTime: 50_000, mapCount: 1};
  return e;
}

let conn: SqlConn;
let store: SqliteSessionStore;
beforeEach(() => { conn = openMigratedNodeSqlite(); store = new SqliteSessionStore(conn); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const make = (meta: Partial<SessionMeta> = {}, readPrices: PriceReader = () => ({})) =>
  new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false, ...meta}, {store, readPrices});

function finish(p: SessionPersistence, drops: Record<number, number> = {}, elapsed = 60_000) {
  return onEngineEvent(p, sessionFinished(drops, elapsed));
}

const existing: DbSession = {
  id: 's1', name: 'My Run', savedAt: '2026-10-01T00:00:00.000Z', totalTime: 100, mapTime: 80, mapCount: 2,
  drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {'100': 9},
  spent: {}, endedAt: Date.parse('2026-10-01T00:00:00.000Z'),
};

describe('atomicity', () => {
  it('update branch: old row unchanged and no rows added when insertRows fails', () => {
    store.insertSession(existing);
    const p = make({sessionName: 'My Run', isOverride: true});
    onEngineEvent(p, mapUnit({200: 1}, 60_000));
    vi.spyOn(store, 'insertRows').mockImplementation(() => { throw new Error('disk full'); });

    expect(() => finish(p, {200: 1})).toThrow('disk full');
    expect(store.getSession('s1')).toEqual(existing);
    expect(store.getRows('s1')).toEqual([]);
  });

  it('insert branch: a real constraint failure inside rows rolls the session insert back', () => {
    const p = make();
    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    // Poison the buffered row so the real INSERT fails (NOT NULL started_at).
    (p as unknown as {_pendingRows: {startedAt: unknown}[]})._pendingRows[0].startedAt = null;

    expect(() => finish(p, {100: 1})).toThrow();
    expect(store.getSession('s1')).toBeNull();
    expect(store.getRows('s1')).toEqual([]);
  });

  it('insert branch with isOverride=false on an id that already exists throws and writes no rows', () => {
    store.insertSession(existing);
    const p = make();
    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    expect(() => finish(p, {100: 1})).toThrow();
    expect(store.getSession('s1')).toEqual(existing);
    expect(store.getRows('s1')).toEqual([]);
  });

  it('update branch on a vanished session row silently writes only the rows (characterization)', () => {
    const p = make({sessionName: 'Gone', isOverride: true});
    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    expect(finish(p, {100: 1})).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toBeNull();
    expect(store.getRows('s1')).toHaveLength(1);   // orphan rows
  });
});

describe('buffer after a failed save (characterization)', () => {
  it('buffer and index survive the throw; a retry commits the same rows', () => {
    const p = make();
    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    const spy = vi.spyOn(store, 'insertRows').mockImplementationOnce(() => { throw new Error('boom'); });

    expect(() => finish(p, {100: 1})).toThrow('boom');
    spy.mockRestore();
    expect(store.getSession('s1')).toBeNull();

    // Retry on the same instance: rows are still buffered, not duplicated.
    expect(finish(p, {100: 1})).toEqual({savedId: 's1'});
    expect(store.getRows('s1').map(r => r.mapIndex)).toEqual([1]);

  });
});

describe('price capture filtering', () => {
  it('ids the reader returns but were not requested are dropped', () => {
    const p = make({}, () => ({'100': 5, '777': 3}));
    finish(p, {100: 1});
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'100': 5});
  });

  it('negative, NaN and zero prices are skipped; fractional kept', () => {
    const p = make({}, () => ({'1': -1, '2': NaN, '3': 0, '4': 0.001}));
    finish(p, {1: 1, 2: 1, 3: 1, 4: 1});
    expect(store.getSession('s1')?.priceSnapshot).toEqual({'4': 0.001});
  });

  it('needed ids include map-row spent ids and the session spent ids; a standalone seasonal adds none', () => {
    const reader = vi.fn<PriceReader>(() => ({}));
    const p = make({}, reader);
    onEngineEvent(p, mapUnit({}, 60_000, {11: 1}));
    onEngineEvent(p, unitFinished(snap('seasonal', {}, 60_000, {seasonalType: 'sandlord'})));
    onEngineEvent(p, sessionFinished({33: 1}, 60_000, {22: 1}));
    expect([...reader.mock.calls[0][0]].sort()).toEqual(['11', '22', '33']);
  });

  it('a throwing reader aborts the save before anything is written', () => {
    const p = make({}, () => { throw new Error('items down'); });
    onEngineEvent(p, mapUnit({100: 1}, 60_000));
    expect(() => finish(p, {100: 1})).toThrow('items down');
    expect(store.getSession('s1')).toBeNull();
    expect(store.getRows('s1')).toEqual([]);
  });
});

describe('misc persistence', () => {
  it('events that are neither a unit nor the session finish are ignored', () => {
    const p = make();
    expect(onEngineEvent(p, {type: 'session_saved', sessionId: 'x'})).toBeNull();
  });

  it('dropsBySource missing on the tracker saves {} ; drops with number keys become string keys', () => {
    finish(make(), {100: 2});
    expect(store.getSession('s1')).toMatchObject({dropsBySource: {}, drops: {'100': 2}, attribution: 'drop-through'});
  });

  it('two persistences sharing a store write independent sessions', () => {
    const a = make({sessionId: 'A'});
    const b = make({sessionId: 'B'});
    onEngineEvent(a, mapUnit({1: 1}, 60_000));
    onEngineEvent(b, mapUnit({2: 1}, 60_000));
    finish(a, {1: 1});
    finish(b, {2: 1});
    expect(store.getRows('A')).toHaveLength(1);
    expect(store.getRows('B')).toHaveLength(1);
    expect(store.getRows('A')[0].drops).toEqual({'1': 1});
  });

  it('continued run with a rename done through a second store handle keeps the new name', () => {
    store.insertSession(existing);
    const p = make({sessionName: 'My Run', isOverride: true});
    new SqliteSessionStore(conn).renameSession('s1', 'Other');
    finish(p, {100: 1});
    expect(store.getSession('s1')?.name).toBe('Other');
  });
});
