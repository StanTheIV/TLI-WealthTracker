/**
 * Adversarial cases for SessionPersistence over the real store: atomicity on
 * both branches, buffer state after a failed save, price filtering.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {SessionPersistence, type PriceReader, type SessionMeta} from '@/main/session-persistence';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {Engine} from '@/main/engine/engine';
import type {DbSession} from '@/shared/contracts/db';
import type {SqlConn} from '@/main/db/sql-conn';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';

const engine = (hasMap = true, spends: Record<string, number> = {}) =>
  ({hasActiveMapTracker: () => hasMap, getLastMapSpends: () => spends}) as unknown as Engine;

function tf(kind: 'session' | 'map' | 'seasonal', drops: Record<number, number>, elapsed: number, extra: Record<string, unknown> = {}) {
  return {type: 'tracker_finished', timestamp: 1_000_000, tracker: {kind, drops, elapsed, active: true, ...extra}} as Extract<EngineEvent, {type: 'tracker_finished'}>;
}

let conn: SqlConn;
let store: SqliteSessionStore;
beforeEach(() => { conn = openMigratedNodeSqlite(); store = new SqliteSessionStore(conn); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const make = (meta: Partial<SessionMeta> = {}, readPrices: PriceReader = () => ({})) =>
  new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false, ...meta}, {store, readPrices});

function finish(p: SessionPersistence, drops: Record<number, number> = {}, elapsed = 60_000) {
  const e = tf('session', drops, elapsed);
  e.sessionMeta = {mapTime: 50_000, mapCount: 1};
  return p.onTrackerFinished(e, engine(false));
}

const existing: DbSession = {
  id: 's1', name: 'My Run', savedAt: '2026-10-01T00:00:00.000Z', totalTime: 100, mapTime: 80, mapCount: 2,
  drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {'100': 9},
};

describe('atomicity', () => {
  it('update branch: old row unchanged and no rows added when insertRows fails', () => {
    store.insertSession(existing);
    const p = make({sessionName: 'My Run', isOverride: true});
    p.onTrackerFinished(tf('map', {200: 1}, 60_000), engine());
    vi.spyOn(store, 'insertRows').mockImplementation(() => { throw new Error('disk full'); });

    expect(() => finish(p, {200: 1})).toThrow('disk full');
    expect(store.getSession('s1')).toEqual(existing);
    expect(store.getRows('s1')).toEqual([]);
  });

  it('insert branch: a real constraint failure inside rows rolls the session insert back', () => {
    const p = make();
    const ev = tf('map', {100: 1}, 60_000);
    p.onTrackerFinished(ev, engine());
    // Poison the buffered row so the real INSERT fails (NOT NULL started_at).
    (p as unknown as {_pendingRows: {startedAt: unknown}[]})._pendingRows[0].startedAt = null;

    expect(() => finish(p, {100: 1})).toThrow();
    expect(store.getSession('s1')).toBeNull();
    expect(store.getRows('s1')).toEqual([]);
  });

  it('insert branch with isOverride=false on an id that already exists throws and writes no rows', () => {
    store.insertSession(existing);
    const p = make();
    p.onTrackerFinished(tf('map', {100: 1}, 60_000), engine());
    expect(() => finish(p, {100: 1})).toThrow();
    expect(store.getSession('s1')).toEqual(existing);
    expect(store.getRows('s1')).toEqual([]);
  });

  it('update branch on a vanished session row silently writes only the rows (characterization)', () => {
    const p = make({sessionName: 'Gone', isOverride: true});
    p.onTrackerFinished(tf('map', {100: 1}, 60_000), engine());
    expect(finish(p, {100: 1})).toEqual({savedId: 's1'});
    expect(store.getSession('s1')).toBeNull();
    expect(store.getRows('s1')).toHaveLength(1);   // orphan rows
  });
});

describe('buffer after a failed save (characterization)', () => {
  it('buffer and index survive the throw; a retry commits the same rows', () => {
    const p = make();
    p.onTrackerFinished(tf('map', {100: 1}, 60_000), engine());
    const spy = vi.spyOn(store, 'insertRows').mockImplementationOnce(() => { throw new Error('boom'); });

    expect(() => finish(p, {100: 1})).toThrow('boom');
    spy.mockRestore();
    expect(store.getSession('s1')).toBeNull();

    // Retry on the same instance: rows are still buffered, not duplicated.
    expect(finish(p, {100: 1})).toEqual({savedId: 's1'});
    expect(store.getRows('s1').map(r => r.mapIndex)).toEqual([1]);

  });

  it('a failed save does not clear staged overlaps that were already promoted', () => {
    const p = make();
    p.onTrackerFinished(tf('seasonal', {300: 1}, 20_000, {seasonalType: 'overrealm'}), engine());
    vi.spyOn(store, 'insertSession').mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => finish(p, {300: 1})).toThrow('boom');
    // Promotion loop emptied _pendingOverlaps into _pendingRows before the throw.
    expect(finish(p, {300: 1})).toEqual({savedId: 's1'});
    expect(store.getRows('s1').map(r => [r.mapIndex, r.parentMapIndex])).toEqual([[1, null]]);
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

  it('needed ids include spent ids from overlap-free map rows and standalone seasonal rows', () => {
    const reader = vi.fn<PriceReader>(() => ({}));
    const p = make({}, reader);
    p.onTrackerFinished(tf('map', {}, 60_000), engine(true, {'11': 1}));
    p.onTrackerFinished(tf('seasonal', {}, 60_000, {seasonalType: 'sandlord'}), engine(false, {'22': 1}));
    finish(p, {33: 1});
    expect([...reader.mock.calls[0][0]].sort()).toEqual(['11', '22', '33']);
  });

  it('a throwing reader aborts the save before anything is written', () => {
    const p = make({}, () => { throw new Error('items down'); });
    p.onTrackerFinished(tf('map', {100: 1}, 60_000), engine());
    expect(() => finish(p, {100: 1})).toThrow('items down');
    expect(store.getSession('s1')).toBeNull();
    expect(store.getRows('s1')).toEqual([]);
  });
});

describe('misc persistence', () => {
  it('non tracker_finished events are ignored', () => {
    const p = make();
    expect(p.onTrackerFinished({type: 'session_saved', sessionId: 'x'} as EngineEvent, engine())).toBeNull();
  });

  it('dropsBySource missing on the tracker saves {} ; drops with number keys become string keys', () => {
    finish(make(), {100: 2});
    expect(store.getSession('s1')).toMatchObject({dropsBySource: {}, drops: {'100': 2}, attribution: 'drop-through'});
  });

  it('two persistences sharing a store write independent sessions', () => {
    const a = make({sessionId: 'A'});
    const b = make({sessionId: 'B'});
    a.onTrackerFinished(tf('map', {1: 1}, 60_000), engine());
    b.onTrackerFinished(tf('map', {2: 1}, 60_000), engine());
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
