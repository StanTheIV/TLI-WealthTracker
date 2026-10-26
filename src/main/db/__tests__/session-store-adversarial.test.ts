/**
 * Adversarial cases for SqliteSessionStore: equivalence with the pre-0.3
 * db.ts SQL, input edge cases, transaction nesting, independent conns.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {SqlConn} from '@/main/db/sql-conn';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import {getDb, initDb} from '@/main/db';

const session = (id: string, savedAt = 'x', extra: Partial<DbSession> = {}): DbSession => ({
  id, name: id, savedAt, totalTime: 1, mapTime: 1, mapCount: 1,
  drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {}, ...extra,
});
const mapRow = (sessionId: string, mapIndex: number, extra: Partial<DbSessionMap> = {}): DbSessionMap => ({
  sessionId, mapIndex, startedAt: mapIndex, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null, ...extra,
});
const count = (c: SqlConn, t: string) => c.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get<{n: number}>()!.n;

let conn: SqlConn;
let store: SqliteSessionStore;
beforeEach(() => { conn = openMigratedNodeSqlite(); store = new SqliteSessionStore(conn); });

describe('equivalence with the pre-0.3 db.ts SQL (inlined)', () => {
  const OLD_INSERT = `
    INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops, drops_by_source, attribution, price_snapshot)
    VALUES (@id, @name, @savedAt, @totalTime, @mapTime, @mapCount, @drops, @dropsBySource, @attribution, @priceSnapshot)`;
  const OLD_UPDATE = `
    UPDATE sessions
    SET name = @name, saved_at = @savedAt, total_time = @totalTime,
        map_time = @mapTime, map_count = @mapCount, drops = @drops,
        drops_by_source = @dropsBySource, attribution = @attribution,
        price_snapshot = @priceSnapshot
    WHERE id = @id`;
  const oldParams = (s: DbSession) => ({
    ...s, drops: JSON.stringify(s.drops), dropsBySource: JSON.stringify(s.dropsBySource),
    priceSnapshot: JSON.stringify(s.priceSnapshot ?? {}),
  });
  const raw = (c: SqlConn, id: string) => c.prepare('SELECT * FROM sessions WHERE id = ?').get(id);

  it('insertSession writes byte-identical raw columns to the old statement', () => {
    const other = openMigratedNodeSqlite();
    const s = session('a', '2026-01-01T00:00:00Z', {
      name: 'Ünï — 日本語 🎉', totalTime: 12.125, drops: {'1': 1, '2': 2}, priceSnapshot: {'1': 0.5},
      dropsBySource: {map: {'1': 1}, overrealm: {'2': 2}},
    });
    other.prepare(OLD_INSERT).run(oldParams(s));
    store.insertSession(s);
    expect(raw(conn, 'a')).toEqual(raw(other, 'a'));
  });

  it('insertSession with undefined priceSnapshot stores {} (old ?? {} behaviour)', () => {
    const s = {...session('a'), priceSnapshot: undefined} as unknown as DbSession;
    store.insertSession(s);
    expect(raw(conn, 'a')).toMatchObject({price_snapshot: '{}'});
    expect(store.getSession('a')?.priceSnapshot).toEqual({});
  });

  it('insertSession ignores extra keys on the session object', () => {
    const s = {...session('a'), junk: 'x', nested: {a: 1}} as unknown as DbSession;
    expect(() => store.insertSession(s)).not.toThrow();
    expect(store.getSession('a')).toEqual(session('a'));
  });

  it('insertSession throws on a missing required key (strict named params)', () => {
    const s = session('a') as Partial<DbSession>;
    delete s.mapTime;
    expect(() => store.insertSession(s as DbSession)).toThrow();
    expect(count(conn, 'sessions')).toBe(0);
  });

  it('duplicate insert id throws and leaves the original intact', () => {
    store.insertSession(session('a', 'x', {name: 'orig'}));
    expect(() => store.insertSession(session('a', 'y', {name: 'dup'}))).toThrow();
    expect(store.getSession('a')?.name).toBe('orig');
  });

  it('updateSessionTotals == old sessionsUpdate on every column except name', () => {
    const other = openMigratedNodeSqlite();
    const base = session('a', '2026-01-01', {name: 'Keep', priceSnapshot: {'1': 1}});
    other.prepare(OLD_INSERT).run(oldParams(base));
    store.insertSession(base);
    const next = session('a', '2026-02-02', {
      name: 'Keep', totalTime: 7.5, mapTime: 3.25, mapCount: 9, drops: {'5': 5},
      dropsBySource: {sandlord: {'5': 5}}, attribution: 'exclusive', priceSnapshot: {'5': 1.5},
    });
    other.prepare(OLD_UPDATE).run(oldParams(next));
    store.updateSessionTotals({...next, name: 'IGNORED'});
    expect(raw(conn, 'a')).toEqual(raw(other, 'a'));
  });

  it('updateSessionTotals with undefined priceSnapshot replaces with {}', () => {
    store.insertSession(session('a', 'x', {priceSnapshot: {'1': 1}}));
    store.updateSessionTotals({...session('a'), priceSnapshot: undefined} as unknown as DbSession);
    expect(raw(conn, 'a')).toMatchObject({price_snapshot: '{}'});
  });

  it('insertRows writes raw columns identical to the old statement', () => {
    const other = openMigratedNodeSqlite();
    const OLD = `INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
      VALUES (@sessionId, @mapIndex, @startedAt, @duration, @drops, @spent, @seasonalType, @parentMapIndex, @phase)`;
    const r = mapRow('a', 3, {drops: {'1': 2}, spent: {'9': 1}, seasonalType: 'sandlord', parentMapIndex: 2, phase: 'hub', startedAt: -5, duration: 1.5});
    other.prepare(OLD).run({...r, drops: JSON.stringify(r.drops), spent: JSON.stringify(r.spent)});
    store.insertRows([r]);
    const q = 'SELECT * FROM session_maps';
    expect(conn.prepare(q).all()).toEqual(other.prepare(q).all());
  });
});

describe('round trips', () => {
  it('unicode and large JSON survive', () => {
    const drops: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) drops[String(i)] = i;
    const s = session('a', 'x', {name: 'O\'Brien "q" \\ x 😀', drops});
    store.insertSession(s);
    expect(store.getSession('a')).toEqual(s);
    store.insertRows([mapRow('a', 1, {drops, spent: {'😀': 1}})]);
    expect(store.getRows('a')[0].drops).toEqual(drops);
    expect(store.getRows('a')[0].spent).toEqual({'😀': 1});
  });

  it('SQL-injection-looking ids and names are bound, not interpolated', () => {
    const id = "x'; DROP TABLE sessions; --";
    store.insertSession(session(id));
    store.renameSession(id, "n'); DELETE FROM sessions; --");
    store.insertRows([mapRow(id, 1)]);
    expect(store.getSession(id)?.name).toBe("n'); DELETE FROM sessions; --");
    store.deleteSession(id);
    expect(count(conn, 'sessions')).toBe(0);
  });

  it('numeric-looking drops keys stay strings (JS integer-key ordering)', () => {
    store.insertSession(session('a', 'x', {drops: {'10': 1, '2': 2}}));
    expect(Object.keys(store.getSession('a')!.drops)).toEqual(['2', '10']);
  });

  it('priceSnapshot with zero/negative/fractional/large prices round-trips', () => {
    const ps = {'1': 0, '2': -1, '3': 1e-9, '4': 1e21};
    store.insertSession(session('a', 'x', {priceSnapshot: ps}));
    expect(store.getSession('a')?.priceSnapshot).toEqual(ps);
  });

  it('parentMapIndex 0 round-trips as 0, not null', () => {
    store.insertRows([mapRow('a', 0, {parentMapIndex: 0, seasonalType: 'sandlord'})]);
    expect(store.getRows('a')[0]).toMatchObject({mapIndex: 0, parentMapIndex: 0});
  });
});

describe('era inference edge cases', () => {
  const ins = (id: string, dbs: string, attr: string) =>
    conn.prepare('INSERT INTO sessions (id, name, saved_at, drops, drops_by_source, attribution) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id, 'x', '{}', dbs, attr);

  it('empty-string attribution infers; a stored value always wins', () => {
    ins('e', '{"map":{}}', '');
    ins('l', '{}', 'legacy');
    ins('x', '{"a":{}}', 'legacy');
    expect(store.getSession('e')?.attribution).toBe('exclusive');
    expect(store.getSession('l')?.attribution).toBe('legacy');
    expect(store.getSession('x')?.attribution).toBe('legacy');
  });

  it('listSessions applies inference per row', () => {
    conn.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('old', 'Old', '2026-01-01', '{}')").run();
    store.insertSession(session('new', '2026-02-01'));
    expect(store.listSessions().map(s => [s.id, s.attribution])).toEqual([['new', 'drop-through'], ['old', 'legacy']]);
  });

  it('listSessions with equal saved_at returns all rows', () => {
    store.insertSession(session('a', 'same'));
    store.insertSession(session('b', 'same'));
    expect(store.listSessions().map(s => s.id).sort()).toEqual(['a', 'b']);
  });
});

describe('maxPrimaryMapIndex', () => {
  it('handles gaps, duplicate primaries and only-overlap sessions', () => {
    store.insertRows([mapRow('g', 1), mapRow('g', 1), mapRow('g', 50)]);
    expect(store.maxPrimaryMapIndex('g')).toBe(50);
    store.insertRows([mapRow('o', 5, {parentMapIndex: 5, seasonalType: 'overrealm'})]);
    expect(store.maxPrimaryMapIndex('o')).toBe(0);
  });

  it('is not fooled by an overlap row whose parentMapIndex is 0', () => {
    store.insertRows([mapRow('z', 4, {parentMapIndex: 0, seasonalType: 'overrealm'}), mapRow('z', 2)]);
    expect(store.maxPrimaryMapIndex('z')).toBe(2);
  });
});

describe('mergePriceSnapshot', () => {
  it('empty input leaves the stored text byte-identical', () => {
    store.insertSession(session('a', 'x', {priceSnapshot: {'1': 1}}));
    const before = conn.prepare('SELECT price_snapshot FROM sessions WHERE id = ?').get('a');
    store.mergePriceSnapshot('a', {});
    expect(conn.prepare('SELECT price_snapshot FROM sessions WHERE id = ?').get('a')).toEqual(before);
  });

  it('an existing zero price is not overwritten; a zero price is added when missing', () => {
    store.insertSession(session('a', 'x', {priceSnapshot: {'1': 0}}));
    store.mergePriceSnapshot('a', {'1': 9, '2': 0});
    expect(store.getSession('a')?.priceSnapshot).toEqual({'1': 0, '2': 0});
  });

  it('is idempotent', () => {
    store.insertSession(session('a'));
    store.mergePriceSnapshot('a', {'7': 7});
    store.mergePriceSnapshot('a', {'7': 8});
    expect(store.getSession('a')?.priceSnapshot).toEqual({'7': 7});
  });

  it('rolls back with an outer transaction', () => {
    store.insertSession(session('a', 'x', {priceSnapshot: {'1': 1}}));
    expect(() => store.transaction(() => {
      store.mergePriceSnapshot('a', {'2': 2});
      expect(store.getSession('a')?.priceSnapshot).toEqual({'1': 1, '2': 2});
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.getSession('a')?.priceSnapshot).toEqual({'1': 1});
  });

  it('does not touch other columns or other sessions', () => {
    store.insertSession(session('a'));
    store.insertSession(session('b'));
    store.mergePriceSnapshot('a', {'1': 1});
    expect(store.getSession('b')).toEqual(session('b'));
    expect(store.getSession('a')).toEqual({...session('a'), priceSnapshot: {'1': 1}});
  });

});

describe('deleteSession / transactions', () => {
  it('inside an outer transaction commits with it', () => {
    store.insertSession(session('a'));
    store.insertRows([mapRow('a', 1)]);
    store.transaction(() => { store.deleteSession('a'); });
    expect(count(conn, 'sessions') + count(conn, 'session_maps')).toBe(0);
  });

  it('deleting a session with many rows leaves unrelated rows', () => {
    store.insertSession(session('a'));
    store.insertRows(Array.from({length: 500}, (_, i) => mapRow('a', i)).concat([mapRow('orphan', 1)]));
    store.deleteSession('a');
    expect(count(conn, 'session_maps')).toBe(1);
  });

  it('deleteSession removes orphan rows even when the session row is absent', () => {
    store.insertRows([mapRow('ghost', 1)]);
    store.deleteSession('ghost');
    expect(store.getRows('ghost')).toEqual([]);
  });

  it('a failing insertRows inside a transaction leaves the connection usable', () => {
    const bad = {...mapRow('a', 1), startedAt: null} as unknown as DbSessionMap;
    expect(() => store.transaction(() => { store.insertRows([bad]); })).toThrow();
    store.insertSession(session('ok'));
    store.transaction(() => { store.insertRows([mapRow('ok', 1)]); });
    expect(store.getRows('ok')).toHaveLength(1);
  });

  it('catching a nested insertRows failure keeps the outer write (savepoint semantics)', () => {
    const bad = {...mapRow('a', 2), startedAt: null} as unknown as DbSessionMap;
    store.transaction(() => {
      store.insertSession(session('a'));
      try { store.insertRows([mapRow('a', 1), bad]); } catch { /* swallowed */ }
    });
    expect(store.getSession('a')).not.toBeNull();
    expect(store.getRows('a')).toEqual([]);
  });

  it('transaction returns the fn result', () => {
    expect(store.transaction(() => 42)).toBe(42);
  });
});

describe('no hidden singleton', () => {
  it('two stores over independent conns do not see each other', () => {
    const s2 = new SqliteSessionStore(openMigratedNodeSqlite());
    store.insertSession(session('a'));
    s2.insertSession(session('b'));
    expect(store.listSessions().map(s => s.id)).toEqual(['a']);
    expect(s2.listSessions().map(s => s.id)).toEqual(['b']);
    store.deleteSession('b');
    expect(s2.getSession('b')).not.toBeNull();
  });

  it('writes go to the conn given, not the db.ts singleton', () => {
    const c = openNodeSqlite();
    runMigrations(c, MIGRATIONS, {backup: () => {}});
    initDb(openNodeSqlite(), {backup: () => {}});
    new SqliteSessionStore(c).insertSession(session('a'));
    expect(count(c, 'sessions')).toBe(1);
    expect(count(getDb(), 'sessions')).toBe(0);
  });

  it('works over getDb() after initDb', () => {
    initDb(openNodeSqlite(), {backup: () => {}});
    const s = new SqliteSessionStore(getDb());
    s.insertSession(session('a'));
    s.insertRows([mapRow('a', 1)]);
    expect(s.getRows('a')).toHaveLength(1);
    s.deleteSession('a');
    expect(s.getSession('a')).toBeNull();
  });
});

describe('rename / unknown ids', () => {
  it('rename of unknown id is a no-op; rename to empty string is stored as is', () => {
    store.renameSession('nope', 'x');
    expect(count(conn, 'sessions')).toBe(0);
    store.insertSession(session('a'));
    store.renameSession('a', '');
    expect(store.getSession('a')?.name).toBe('');
  });

  it('getRows / maxPrimaryMapIndex for unknown id', () => {
    expect(store.getRows('none')).toEqual([]);
    expect(store.maxPrimaryMapIndex('none')).toBe(0);
  });
});
