/**
 * Post-v5 behaviour through SqliteSessionStore + SessionPersistence on a DB that went v4 -> v5:
 * a full persisted run, cascade deletes, units for a vanished session, index collisions that must
 * roll the whole unit back, and the continue index (maxPrimaryMapIndex).
 */
import {describe, it, expect, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import {makePersistence, onEngineEvent, sessionFinished, sessionStarted, snap, unitFinished} from '@/test/unit-events';

const conns: SqlConn[] = [];
afterEach(() => { while (conns.length) conns.pop()!.close(); });

/** A v5 DB reached by migrating a v4 one that held a dup session and an orphan row. */
function migrated(): {conn: SqlConn; store: SqliteSessionStore} {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  conns.push(conn);
  runMigrations(conn, MIGRATIONS.slice(0, 4), {backup: () => {}});
  conn.exec(`
    INSERT INTO sessions (id, name, saved_at, drops) VALUES ('dup', 'Dup', '2026-10-01T00:00:00.000Z', '{}');
    INSERT INTO session_maps (session_id, map_index, started_at, ended_at, duration) VALUES ('dup', 1, 1, 2, 1), ('dup', 1, 3, 4, 1), ('ghost', 1, 1, 2, 1);
  `);
  runMigrations(conn, MIGRATIONS, {backup: () => {}});
  return {conn, store: new SqliteSessionStore(conn)};
}

const count = (c: SqlConn, t: string) => c.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get<{n: number}>()!.n;

describe('SessionPersistence on a migrated DB', () => {
  it('a full run persists: units with overlaps and a standalone seasonal, stop closes it; no row id reuses the wiped ones', () => {
    const {conn, store} = migrated();
    const p = makePersistence({store, readPrices: () => ({})});
    onEngineEvent(p, sessionStarted());
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [{tracker: snap('seasonal', {300: 1}, 10_000, {seasonalType: 'arcana'})}]));
    onEngineEvent(p, unitFinished(snap('seasonal', {200: 1}, 30_000, {seasonalType: 'sandlord'})));
    onEngineEvent(p, unitFinished(snap('map', {100: 2}, 50_000)));
    expect(onEngineEvent(p, sessionFinished({drops: {100: 3}, mapCount: 2}))).toEqual({savedId: 's1'});

    expect(store.getRows('s1').map(r => [r.mapIndex, r.parentMapIndex, r.seasonalType])).toEqual([
      [1, null, null], [1, 1, 'arcana'], [2, null, 'sandlord'], [3, null, null],
    ]);
    expect(store.maxPrimaryMapIndex('s1')).toBe(3);
    expect(store.getSession('s1')?.endedAt).not.toBeNull();
    expect(store.getSession('s1')?.attribution).toBe('drop-through');
    expect(conn.prepare("SELECT MIN(id) AS m FROM session_maps WHERE session_id = 's1'").get<{m: number}>()!.m).toBeGreaterThan(3);   // 'dup' rows 1-2, orphan 3
    expect(store.getSession('dup')).toBeNull();
  });

  it('deleteSession cascades to every row of that session only, and is a no-op for an unknown id', () => {
    const {conn, store} = migrated();
    for (const id of ['a', 'b']) {
      const p = makePersistence({store, readPrices: () => ({})}, {sessionId: id});
      onEngineEvent(p, sessionStarted({sessionId: id}));
      onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [{tracker: snap('seasonal', {300: 1}, 10_000, {seasonalType: 'arcana'})}]));
    }
    store.deleteSession('a');
    expect(store.getRows('a')).toEqual([]);
    expect(store.getRows('b')).toHaveLength(2);
    store.deleteSession('never-existed');
    expect(count(conn, 'session_maps')).toBe(2);
  });

  it('a unit for a vanished session throws and writes nothing (no row, no resurrected session, no FK violation)', () => {
    const {conn, store} = migrated();
    const p = makePersistence({store, readPrices: () => ({})});
    onEngineEvent(p, sessionStarted());
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    store.deleteSession('s1');
    const rowsBefore = count(conn, 'session_maps');
    expect(() => onEngineEvent(p, unitFinished(snap('map', {100: 2}, 60_000), [{tracker: snap('seasonal', {300: 1}, 10_000, {seasonalType: 'arcana'})}]))).toThrow();
    expect(count(conn, 'session_maps')).toBe(rowsBefore);
    expect(count(conn, 'sessions')).toBe(0);
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a unit whose primary index already exists rolls back whole: totals, rows and prices of the failed unit are not stored', () => {
    const {store} = migrated();
    const p = makePersistence({store, readPrices: () => ({100: 5})});
    onEngineEvent(p, sessionStarted());
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000), [], undefined));
    const before = {session: store.getSession('s1'), rows: store.getRows('s1')};
    // a second persistence for the same session that believes it is on index 1 again (stale continue)
    const stale = makePersistence({store, readPrices: () => ({100: 5, 200: 9})}, {continued: true, nextMapIndex: 1});
    expect(() => onEngineEvent(stale, unitFinished(snap('map', {200: 7}, 99_000), [{tracker: snap('seasonal', {300: 1}, 10_000, {seasonalType: 'arcana'})}]))).toThrow(/UNIQUE/);
    expect({session: store.getSession('s1'), rows: store.getRows('s1')}).toEqual(before);
    expect(store.getSession('s1')?.priceSnapshot).not.toHaveProperty('200');
  });

  it('an overlap row sharing its primary index inserts fine and does not move maxPrimaryMapIndex', () => {
    const {store} = migrated();
    const p = makePersistence({store, readPrices: () => ({})});
    onEngineEvent(p, sessionStarted());
    onEngineEvent(p, unitFinished(snap('map', {100: 1}, 60_000)));
    store.insertRows([{sessionId: 's1', mapIndex: 1, startedAt: 1, endedAt: 2, duration: 1, drops: {}, spent: {}, seasonalType: 'vorex', parentMapIndex: 1, phase: null}]);
    expect(store.getRows('s1')).toHaveLength(2);
    expect(store.maxPrimaryMapIndex('s1')).toBe(1);
  });
});

describe('maxPrimaryMapIndex after v5', () => {
  const row = (sessionId: string, mapIndex: number, parentMapIndex: number | null) => ({
    sessionId, mapIndex, startedAt: 1, endedAt: 2, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex, phase: null,
  });

  it('counts primaries only (an overlap-only session reads 0), is per session, and 0 for a missing or wiped one', () => {
    const {conn, store} = migrated();
    for (const id of ['x', 'y', 'z']) {
      conn.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES (?, ?, '2026-10-01T00:00:00.000Z', '{}')").run(id, id);
    }
    store.insertRows([row('x', 1, null), row('x', 7, null), row('x', 9, 9), row('y', 4, 4), row('z', -3, null)]);
    expect(store.maxPrimaryMapIndex('x')).toBe(7);
    expect(store.maxPrimaryMapIndex('y')).toBe(0);
    expect(store.maxPrimaryMapIndex('z')).toBe(-3);
    expect(store.maxPrimaryMapIndex('dup')).toBe(0);
    expect(store.maxPrimaryMapIndex('nope')).toBe(0);
    store.deleteSession('x');
    expect(store.maxPrimaryMapIndex('x')).toBe(0);
  });

  it('a continued run starts at max + 1 and never collides', () => {
    const {store} = migrated();
    const first = makePersistence({store, readPrices: () => ({})});
    onEngineEvent(first, sessionStarted());
    onEngineEvent(first, unitFinished(snap('map', {100: 1}, 60_000)));
    onEngineEvent(first, unitFinished(snap('map', {100: 1}, 60_000)));
    onEngineEvent(first, sessionFinished({drops: {100: 2}, mapCount: 2}));

    const next = store.maxPrimaryMapIndex('s1') + 1;
    const cont = makePersistence({store, readPrices: () => ({})}, {continued: true, nextMapIndex: next});
    onEngineEvent(cont, sessionStarted({continued: true}));
    onEngineEvent(cont, unitFinished(snap('map', {100: 1}, 60_000), [{tracker: snap('seasonal', {300: 1}, 10_000, {seasonalType: 'arcana'})}]));
    expect(store.getRows('s1').filter(r => r.parentMapIndex === null).map(r => r.mapIndex)).toEqual([1, 2, 3]);
  });
});
