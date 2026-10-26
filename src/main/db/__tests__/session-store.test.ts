/**
 * SqliteSessionStore over a migrated node:sqlite conn: the session and
 * session_maps SQL, read-time era inference, and transaction boundaries.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {SqlConn} from '@/main/db/sql-conn';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';

const session = (id: string, savedAt: string, extra: Partial<DbSession> = {}): DbSession => ({
  id, name: id, savedAt, totalTime: 1, mapTime: 1, mapCount: 1,
  drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {}, ...extra,
});

const mapRow = (sessionId: string, mapIndex: number, extra: Partial<DbSessionMap> = {}): DbSessionMap => ({
  sessionId, mapIndex, startedAt: mapIndex, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null, ...extra,
});

const countRows = (conn: SqlConn, table: 'sessions' | 'session_maps') =>
  conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{n: number}>()!.n;

let conn:  SqlConn;
let store: SqliteSessionStore;

beforeEach(() => {
  conn  = openMigratedNodeSqlite();
  store = new SqliteSessionStore(conn);
});

describe('SqliteSessionStore — sessions', () => {
  it('insertSession / getSession round-trip every field (times in seconds, JSON columns)', () => {
    const s: DbSession = {
      id:            's1',
      name:          'Run',
      savedAt:       '2026-10-01T00:00:00.000Z',
      totalTime:     3600.5,
      mapTime:       3000.25,
      mapCount:      7,
      drops:         {'100': 3, '200': 1},
      dropsBySource: {map: {'100': 3}, overrealm: {'200': 1}},
      attribution:   'drop-through',
      priceSnapshot: {'100': 2.5},
    };
    store.insertSession(s);
    expect(store.getSession('s1')).toEqual(s);
    const raw = conn.prepare('SELECT total_time, drops, price_snapshot FROM sessions WHERE id = ?').get('s1');
    expect(raw).toEqual({total_time: 3600.5, drops: '{"100":3,"200":1}', price_snapshot: '{"100":2.5}'});
  });

  it('getSession of an unknown id is null', () => {
    expect(store.getSession('nope')).toBeNull();
  });

  it('listSessions is ordered by saved_at, newest first', () => {
    store.insertSession(session('a', '2026-10-02T00:00:00Z'));
    store.insertSession(session('b', '2026-10-03T00:00:00Z'));
    store.insertSession(session('c', '2026-10-01T00:00:00Z'));
    expect(store.listSessions().map(s => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('infers the attribution era of rows written before the column', () => {
    conn.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('old', 'Old', 'x', '{}')").run();
    conn.prepare(`INSERT INTO sessions (id, name, saved_at, drops, drops_by_source) VALUES ('mid', 'Mid', 'y', '{}', '{"map":{"1":1}}')`).run();
    expect(store.getSession('old')).toMatchObject({attribution: 'legacy', dropsBySource: {}, priceSnapshot: {}});
    expect(store.getSession('mid')?.attribution).toBe('exclusive');
    // A stored attribution always wins over inference.
    store.insertSession(session('new', 'z', {dropsBySource: {}}));
    expect(store.getSession('new')?.attribution).toBe('drop-through');
  });

  it('updateSessionTotals overwrites run data but never the name', () => {
    store.insertSession(session('a', '2026-10-01T00:00:00Z', {name: 'My Run', priceSnapshot: {'100': 1, '300': 4}}));
    store.updateSessionTotals({
      id:            'a',
      name:          'ignored',
      savedAt:       '2026-10-05T00:00:00Z',
      totalTime:     99,
      mapTime:       88,
      mapCount:      5,
      drops:         {'200': 9},
      dropsBySource: {sandlord: {'200': 9}},
      attribution:   'exclusive',
      priceSnapshot: {'200': 1},
    });
    expect(store.getSession('a')).toEqual({
      id:            'a',
      name:          'My Run',
      savedAt:       '2026-10-05T00:00:00Z',
      totalTime:     99,
      mapTime:       88,
      mapCount:      5,
      drops:         {'200': 9},
      dropsBySource: {sandlord: {'200': 9}},
      attribution:   'exclusive',
      priceSnapshot: {'200': 1},   // replaced whole
    });
  });

  it('updateSessionTotals of an unknown id writes nothing', () => {
    store.updateSessionTotals(session('ghost', 'x'));
    expect(countRows(conn, 'sessions')).toBe(0);
  });

  it('renameSession changes only the name', () => {
    store.insertSession(session('a', 'x'));
    store.renameSession('a', 'Bee');
    expect(store.getSession('a')).toEqual({...session('a', 'x'), name: 'Bee'});
  });

  it('deleteSession removes the session and its rows, leaving other sessions', () => {
    store.insertSession(session('a', 'x'));
    store.insertSession(session('b', 'y'));
    store.insertRows([mapRow('a', 1), mapRow('b', 1), mapRow('b', 2)]);

    store.deleteSession('b');

    expect(store.getSession('b')).toBeNull();
    expect(store.getRows('b')).toEqual([]);
    expect(store.getSession('a')).not.toBeNull();
    expect(store.getRows('a')).toHaveLength(1);
    expect(() => store.deleteSession('nope')).not.toThrow();
  });

  it('deleteSession rolls back as one unit', () => {
    store.insertSession(session('a', 'x'));
    store.insertRows([mapRow('a', 1)]);
    expect(() => store.transaction(() => {
      store.deleteSession('a');
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.getSession('a')).not.toBeNull();
    expect(store.getRows('a')).toHaveLength(1);
  });
});

describe('SqliteSessionStore — mergePriceSnapshot', () => {
  it('adds missing prices and never overwrites existing ones', () => {
    store.insertSession(session('a', 'x', {priceSnapshot: {'100': 1}}));
    store.mergePriceSnapshot('a', {'100': 50, '200': 2});
    expect(store.getSession('a')?.priceSnapshot).toEqual({'100': 1, '200': 2});
  });

  it('fills an empty snapshot', () => {
    store.insertSession(session('a', 'x'));
    store.mergePriceSnapshot('a', {'100': 3});
    expect(store.getSession('a')?.priceSnapshot).toEqual({'100': 3});
  });

  it('is a no-op for an unknown session', () => {
    expect(() => store.mergePriceSnapshot('nope', {'100': 3})).not.toThrow();
    expect(countRows(conn, 'sessions')).toBe(0);
  });
});

describe('SqliteSessionStore — session maps', () => {
  it('insertRows / getRows round-trip every column in insertion (id) order', () => {
    const rows: DbSessionMap[] = [
      mapRow('a', 2, {startedAt: 1_000, duration: 60_000, drops: {'100': 5}, spent: {'42': 3}}),
      mapRow('a', 1, {startedAt: 2_000, duration: 5_000, drops: {'200': 1}, seasonalType: 'sandlord', parentMapIndex: 1, phase: 'map'}),
      mapRow('a', 3, {seasonalType: 'sandlord', phase: 'hub'}),
    ];
    store.insertRows(rows);
    store.insertRows([mapRow('other', 1)]);
    store.insertRows([mapRow('a', 0)]);
    expect(store.getRows('a')).toEqual([...rows, mapRow('a', 0)]);
    expect(store.getRows('other')).toEqual([mapRow('other', 1)]);
  });

  it('insertRows with no rows is a no-op', () => {
    store.insertRows([]);
    expect(countRows(conn, 'session_maps')).toBe(0);
  });

  it('insertRows is all-or-nothing on its own', () => {
    // NOT NULL started_at fails the second row; the first must not survive.
    const bad = {...mapRow('a', 2), startedAt: null} as unknown as DbSessionMap;
    expect(() => store.insertRows([mapRow('a', 1), bad])).toThrow();
    expect(countRows(conn, 'session_maps')).toBe(0);
  });

  it('maxPrimaryMapIndex is the highest primary index, per session', () => {
    expect(store.maxPrimaryMapIndex('a')).toBe(0);
    store.insertRows([
      mapRow('a', 1),
      mapRow('a', 2),
      mapRow('a', 3, {seasonalType: 'sandlord'}),                     // standalone seasonal counts
      mapRow('a', 9, {seasonalType: 'overrealm', parentMapIndex: 2}), // overlap rows don't
      mapRow('b', 7),
    ]);
    expect(store.maxPrimaryMapIndex('a')).toBe(3);
    expect(store.maxPrimaryMapIndex('b')).toBe(7);
    expect(store.maxPrimaryMapIndex('c')).toBe(0);
  });
});

describe('SqliteSessionStore — transaction', () => {
  it('commits the session and its rows together', () => {
    const out = store.transaction(() => {
      store.insertSession(session('a', 'x'));
      store.insertRows([mapRow('a', 1), mapRow('a', 2)]);
      return 'done';
    });
    expect(out).toBe('done');
    expect(store.getSession('a')).not.toBeNull();
    expect(store.getRows('a')).toHaveLength(2);
  });

  it('a throw rolls back both tables, including a nested insertRows', () => {
    expect(() => store.transaction(() => {
      store.insertSession(session('a', 'x'));
      store.insertRows([mapRow('a', 1)]);
      throw new Error('boom');
    })).toThrow('boom');
    expect(countRows(conn, 'sessions')).toBe(0);
    expect(countRows(conn, 'session_maps')).toBe(0);
  });

  it('a failing nested insertRows propagates and rolls back the outer write', () => {
    const bad = {...mapRow('a', 1), startedAt: null} as unknown as DbSessionMap;
    expect(() => store.transaction(() => {
      store.insertSession(session('a', 'x'));
      store.insertRows([bad]);
    })).toThrow();
    expect(countRows(conn, 'sessions')).toBe(0);
  });
});
