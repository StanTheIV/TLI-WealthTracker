/**
 * Migration v5 `session-integrity` (foreignKeysOff): every session with a duplicated primary
 * `(session_id, map_index)` is deleted whole (a generic rule, never renumbered); session_maps is
 * rebuilt with `session_id REFERENCES sessions(id) ON DELETE CASCADE`, ids kept, orphan rows
 * dropped, plus a partial unique index on the primary key; attribution '' is backfilled with the
 * former read-time rule; seasonal_stats and wealth_datapoints.session_id are dropped.
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import {SqliteSessionStore} from '@/main/db/session-store';
import {log} from '@/main/logger';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

const conns: SqlConn[] = [];
afterEach(() => {
  while (conns.length) conns.pop()!.close();
  vi.restoreAllMocks();
});

function open(): SqlConn {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  conns.push(conn);
  return conn;
}

const UP_TO_V4 = MIGRATIONS.slice(0, 4);
const LATEST   = MIGRATIONS[MIGRATIONS.length - 1].version;

type FxRow = [mapIndex: number, parent: number | null, seasonal: string | null];
interface FxSession {id: string; attribution: string; dbs: string; endedAt: number | null; rows: FxRow[]}

const MAP = (i: number): FxRow => [i, null, null];
const OVERLAP = (parent: number, type = 'arcana'): FxRow => [parent, parent, type];   // overlap rows carry their parent's index

/** Inserted in this order, so `cont` (a dup session) holds the highest row ids. */
const FIXTURE: FxSession[] = [
  // Control: legitimate overlaps repeat their parent's index (several per map, same type twice).
  {id: 'clean', attribution: 'drop-through', dbs: '{"map":{"100":3}}', endedAt: 5000,
    rows: [MAP(1), OVERLAP(1), OVERLAP(1), OVERLAP(1, 'overrealm'), MAP(2), [3, null, 'sandlord'], MAP(4), OVERLAP(4, 'vorex')]},
  // A standalone seasonal primary sharing its index with a map.
  {id: 'seasonalDup', attribution: '', dbs: '{"map":{"1":1}}', endedAt: 6000, rows: [MAP(1), MAP(2), [2, null, 'sandlord']]},
  // A live session with a duplicate.
  {id: 'liveDup', attribution: 'drop-through', dbs: '{}', endedAt: null, rows: [MAP(1), MAP(1)]},
  // Attribution backfill.
  {id: 'blankLegacy',   attribution: '', dbs: '{}',                endedAt: 7000, rows: [MAP(1), OVERLAP(1)]},
  {id: 'blankExcl',     attribution: '', dbs: '{"map":{"100":3}}', endedAt: 7001, rows: []},
  {id: 'blankEmptyMap', attribution: '', dbs: '{"map":{}}',        endedAt: 7002, rows: []},
  {id: 'storedExcl',    attribution: 'exclusive', dbs: '{}',       endedAt: 7003, rows: []},
  {id: 'storedLegacy',  attribution: 'legacy', dbs: '{"map":{"1":1}}', endedAt: 7004, rows: []},
  {id: 'live',          attribution: 'drop-through', dbs: '{}',    endedAt: null, rows: [MAP(1), MAP(2)]},
  // Two Continue segments, each restarting at 1.
  {id: 'cont', attribution: 'drop-through', dbs: '{}', endedAt: 8000, rows: [MAP(1), OVERLAP(1), MAP(2), MAP(1), MAP(2), MAP(3)]},
];
const DUPS = ['cont', 'liveDup', 'seasonalDup'];

function insertSession(c: SqlConn, s: Omit<FxSession, 'rows'>): void {
  c.prepare(`INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops, drops_by_source, attribution, price_snapshot, spent, ended_at)
             VALUES (?, ?, '2026-10-01T00:00:00.000Z', 60, 50, 2, '{"100":3}', ?, ?, '{"100":1.5}', '{"300":2}', ?)`)
    .run(s.id, `Name ${s.id}`, s.dbs, s.attribution, s.endedAt);
}

function insertRow(c: SqlConn, sessionId: string, [mapIndex, parent, seasonal]: FxRow, t = 1000): void {
  c.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, ended_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
             VALUES (?, ?, ?, ?, 500, '{"100":1}', '{}', ?, ?, ?)`)
    .run(sessionId, mapIndex, t, t + 600, seasonal, parent, seasonal === 'sandlord' ? 'hub' : null);
}

function v4Db(fixture: FxSession[] = FIXTURE): SqlConn {
  const conn = open();
  runMigrations(conn, UP_TO_V4, {backup: () => {}});
  let t = 1000;
  for (const s of fixture) {
    insertSession(conn, s);
    for (const r of s.rows) insertRow(conn, s.id, r, t += 1000);
  }
  return conn;
}

const version  = (c: SqlConn) => Number(c.getPragma('user_version'));
const migrate  = (c: SqlConn, backup: (r: string) => void = () => {}) => runMigrations(c, MIGRATIONS, {backup});
const ids      = (c: SqlConn) => c.prepare('SELECT id FROM sessions ORDER BY id').all<{id: string}>().map(r => r.id);
const rowsOf   = (c: SqlConn, id: string) => c.prepare('SELECT * FROM session_maps WHERE session_id = ? ORDER BY id').all(id);
const sessOf   = (c: SqlConn, id: string) => c.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
const count    = (c: SqlConn, t: string) => c.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get<{n: number}>()!.n;
const hasTable = (c: SqlConn, t: string) => c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
const columns  = (c: SqlConn, t: string) => c.prepare(`PRAGMA table_info(${t})`).all<{name: string}>().map(x => x.name);
const maxRowId = (c: SqlConn) => c.prepare('SELECT MAX(id) AS m FROM session_maps').get<{m: number}>()!.m;
const logged   = (spy: {mock: {calls: unknown[][]}}) => spy.mock.calls.map(call => call.map(String).join(' '));

/** rowToSession before v5: a stored value wins, else zero drops_by_source keys → legacy, else exclusive. */
const oldReadTimeRule = (attribution: string, dbs: string) =>
  attribution || (Object.keys(JSON.parse(dbs)).length === 0 ? 'legacy' : 'exclusive');

describe('MIGRATIONS[4]', () => {
  it('is v5 session-integrity with the pre-session-integrity backup and foreign keys off, and the latest step', () => {
    expect(MIGRATIONS[4]).toMatchObject({version: 5, name: 'session-integrity', backup: 'pre-session-integrity', foreignKeysOff: true});
    expect(MIGRATIONS).toHaveLength(5);
    expect(LATEST).toBe(5);
  });
});

describe('v4 -> v5: sessions with a duplicated primary map index', () => {
  it('are deleted whole — the session and every row, overlaps included, live or not', () => {
    const conn = v4Db();
    migrate(conn);
    expect(version(conn)).toBe(5);
    for (const id of DUPS) {
      expect(sessOf(conn, id), id).toBeUndefined();
      expect(rowsOf(conn, id), id).toEqual([]);
    }
    expect(ids(conn)).toEqual(FIXTURE.map(s => s.id).filter(id => !DUPS.includes(id)).sort());
  });

  it('a clean session is byte-identical: row ids and every column, the session row except a backfilled attribution', () => {
    const conn   = v4Db();
    const before = {
      session: sessOf(conn, 'clean'), rows: rowsOf(conn, 'clean'), live: rowsOf(conn, 'live'),
      legacySession: sessOf(conn, 'blankLegacy') as object, legacyRows: rowsOf(conn, 'blankLegacy'),
    };
    migrate(conn);
    expect(sessOf(conn, 'clean')).toEqual(before.session);
    expect(rowsOf(conn, 'clean')).toEqual(before.rows);
    expect(rowsOf(conn, 'live')).toEqual(before.live);
    expect(rowsOf(conn, 'blankLegacy')).toEqual(before.legacyRows);
    expect(sessOf(conn, 'blankLegacy')).toEqual({...before.legacySession, attribution: 'legacy'});
  });

  it('legitimate overlaps survive: several per map, sharing their primary index and type', () => {
    const conn = v4Db();
    migrate(conn);
    const rows = rowsOf(conn, 'clean') as {map_index: number; parent_map_index: number | null; seasonal_type: string | null}[];
    expect(rows.map(r => [r.map_index, r.parent_map_index, r.seasonal_type])).toEqual(FIXTURE[0].rows);
    expect(rows.filter(r => r.map_index === 1)).toHaveLength(4);
  });

  it('logs every deleted session with its id and name, and the counts', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(v4Db());
    const lines = logged(info);
    for (const id of DUPS) expect(lines.some(l => l.includes(id) && l.includes(`Name ${id}`)), id).toBe(true);
    // cont 6 + liveDup 2 + seasonalDup 3 rows
    expect(lines.some(l => l.includes('3 sessions') && l.includes('11 rows'))).toBe(true);
  });

  it('every session left has unique primary indexes; the runner FK check passed (no violation left)', () => {
    const conn = v4Db();
    migrate(conn);
    expect(conn.prepare(`SELECT session_id, map_index FROM session_maps WHERE parent_map_index IS NULL
                         GROUP BY session_id, map_index HAVING COUNT(*) > 1`).all()).toEqual([]);
    expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('v4 -> v5: the session_maps rebuild', () => {
  it('keeps the columns in order, with the same types, nullability and defaults', () => {
    const conn   = v4Db();
    const before = conn.prepare('PRAGMA table_info(session_maps)').all();
    migrate(conn);
    expect(conn.prepare('PRAGMA table_info(session_maps)').all()).toEqual(before);
    expect(columns(conn, 'session_maps').at(-1)).toBe('ended_at');
  });

  it('session_id references sessions(id) ON DELETE CASCADE', () => {
    const conn = v4Db();
    migrate(conn);
    expect(conn.prepare('PRAGMA foreign_key_list(session_maps)').all()).toEqual([
      {id: 0, seq: 0, table: 'sessions', from: 'session_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE'},
    ]);
  });

  it('has idx_session_maps_session and the partial unique idx_session_maps_primary', () => {
    const conn = v4Db();
    migrate(conn);
    const list = conn.prepare('PRAGMA index_list(session_maps)').all<{name: string; unique: number; partial: number}>()
      .map(({name, unique, partial}) => ({name, unique, partial})).sort((a, b) => a.name.localeCompare(b.name));
    expect(list).toEqual([
      {name: 'idx_session_maps_primary', unique: 1, partial: 1},
      {name: 'idx_session_maps_session', unique: 0, partial: 0},
    ]);
    const cols = (idx: string) => conn.prepare(`PRAGMA index_info(${idx})`).all<{name: string}>().map(c => c.name);
    expect(cols('idx_session_maps_primary')).toEqual(['session_id', 'map_index']);
    expect(cols('idx_session_maps_session')).toEqual(['session_id']);
    const sql = conn.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_session_maps_primary'").get<{sql: string}>()!.sql;
    expect(sql).toMatch(/WHERE parent_map_index IS NULL$/);
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'session_maps%'").all()).toEqual([{name: 'session_maps'}]);
  });

  it('drops orphan rows (no session) and logs their count', () => {
    const conn = v4Db();
    insertRow(conn, 'ghost', MAP(1));
    insertRow(conn, 'ghost', MAP(1));   // an orphan duplicate: dropped as an orphan, never reaches the index
    insertRow(conn, 'gone', OVERLAP(3));
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(conn);
    expect(conn.prepare("SELECT COUNT(*) AS n FROM session_maps WHERE session_id IN ('ghost', 'gone')").get()).toEqual({n: 0});
    expect(logged(info).some(l => l.includes('3 orphan rows'))).toBe(true);
  });

  it('enforces the rules afterwards: dup primary throws, dup overlap is fine, orphan throws, a session delete cascades', () => {
    const conn = v4Db();
    migrate(conn);
    expect(() => insertRow(conn, 'clean', MAP(2))).toThrow(/UNIQUE/);
    expect(() => insertRow(conn, 'clean', [2, null, 'sandlord'])).toThrow(/UNIQUE/);
    insertRow(conn, 'clean', OVERLAP(2));
    insertRow(conn, 'clean', OVERLAP(2));
    insertRow(conn, 'clean', MAP(5));
    expect(() => insertRow(conn, 'ghost', MAP(1))).toThrow(/FOREIGN KEY/);

    const live = count(conn, 'session_maps') - rowsOf(conn, 'clean').length;
    conn.prepare("DELETE FROM sessions WHERE id = 'clean'").run();
    expect(rowsOf(conn, 'clean')).toEqual([]);
    expect(count(conn, 'session_maps')).toBe(live);
  });

  it('the next row id continues past the old maximum, wiped rows included (no id is reused)', () => {
    const conn   = v4Db();
    const oldMax = maxRowId(conn);   // a row of `cont`, which v5 deletes
    expect(rowsOf(conn, 'cont').map(r => (r as {id: number}).id)).toContain(oldMax);
    migrate(conn);
    expect(maxRowId(conn)).toBeLessThan(oldMax);
    insertRow(conn, 'clean', MAP(9));
    expect(maxRowId(conn)).toBe(oldMax + 1);
  });

  it('the sequence also carries over when no row survives', () => {
    const conn = v4Db([{id: 'only', attribution: 'drop-through', dbs: '{}', endedAt: 1, rows: [MAP(1), MAP(1)]}]);
    const oldMax = maxRowId(conn);
    migrate(conn);
    expect(count(conn, 'session_maps')).toBe(0);
    insertSession(conn, {id: 'next', attribution: 'drop-through', dbs: '{}', endedAt: null});
    insertRow(conn, 'next', MAP(1));
    expect(maxRowId(conn)).toBe(oldMax + 1);
  });
});

describe('v4 -> v5: attribution backfill', () => {
  it("stores the former read-time rule for '': {} → legacy, any key → exclusive; stored values are kept", () => {
    const conn = v4Db();
    migrate(conn);
    const attr = (id: string) => (sessOf(conn, id) as {attribution: string}).attribution;
    expect(attr('blankLegacy')).toBe('legacy');
    expect(attr('blankExcl')).toBe('exclusive');
    expect(attr('blankEmptyMap')).toBe('exclusive');
    expect(attr('storedExcl')).toBe('exclusive');
    expect(attr('storedLegacy')).toBe('legacy');
    expect(attr('clean')).toBe('drop-through');
    expect(conn.prepare("SELECT COUNT(*) AS n FROM sessions WHERE attribution = ''").get()).toEqual({n: 0});
  });

  it('equals the old read-time inference for every surviving session, and the store reads it back', () => {
    const conn     = v4Db();
    const expected = Object.fromEntries(conn.prepare('SELECT id, attribution, drops_by_source FROM sessions').all<{id: string; attribution: string; drops_by_source: string}>()
      .map(s => [s.id, oldReadTimeRule(s.attribution, s.drops_by_source)]));
    migrate(conn);
    const store = new SqliteSessionStore(conn);
    for (const s of store.listSessions()) expect(s.attribution, s.id).toBe(expected[s.id]);
    expect(store.listSessions()).toHaveLength(FIXTURE.length - DUPS.length);
  });

  it('unparsable drops_by_source → legacy, with a warning naming the session', () => {
    const conn = v4Db([{id: 'bad', attribution: '', dbs: 'not json', endedAt: 1, rows: []}]);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    migrate(conn);
    expect((sessOf(conn, 'bad') as {attribution: string}).attribution).toBe('legacy');
    expect(logged(warn).some(l => l.includes('bad') && l.includes('not json'))).toBe(true);
  });

  it('logs the backfill counts', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(v4Db());
    // blankLegacy, blankExcl, blankEmptyMap (seasonalDup was '' but is deleted first)
    expect(logged(info).some(l => l.includes('3 sessions (1 legacy, 2 exclusive, 0 unparsable)'))).toBe(true);
  });
});

describe('v4 -> v5: dead surface and untouched data', () => {
  it('drops seasonal_stats; a DB without it migrates too', () => {
    const conn = v4Db();
    conn.exec("INSERT INTO seasonal_stats VALUES ('arcana', 2, 30, 4.5, '{}')");
    migrate(conn);
    expect(hasTable(conn, 'seasonal_stats')).toBe(false);

    const without = v4Db();
    without.exec('DROP TABLE seasonal_stats');
    migrate(without);
    expect(version(without)).toBe(5);
  });

  it('drops wealth_datapoints.session_id, keeping every other column, the ids, the breakdowns and idx_wealth_timestamp', () => {
    const conn = v4Db();
    conn.exec(`INSERT INTO wealth_datapoints (id, timestamp, value, session_id, breakdown) VALUES
               (7, 1, 10, 'clean', '{"100":{"qty":1,"price":2,"total":2}}'), (9, 2, 11.5, NULL, '{}'), (12, 3, 0, 'nowhere', '{}')`);
    const before = conn.prepare('SELECT id, timestamp, value, breakdown FROM wealth_datapoints ORDER BY id').all();
    migrate(conn);
    expect(columns(conn, 'wealth_datapoints')).toEqual(['id', 'timestamp', 'value', 'breakdown']);
    expect(conn.prepare('SELECT * FROM wealth_datapoints ORDER BY id').all()).toEqual(before);
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'wealth_datapoints'").all())
      .toEqual([{name: 'idx_wealth_timestamp'}]);
    conn.prepare("INSERT INTO wealth_datapoints (timestamp, value, breakdown) VALUES (4, 1, '{}')").run();
    expect(conn.prepare('SELECT MAX(id) AS m FROM wealth_datapoints').get()).toEqual({m: 13});
  });

  it('never touches a session end: a live (NULL) session stays live, ended ones keep their value', () => {
    const conn   = v4Db();
    const before = conn.prepare('SELECT id, ended_at FROM sessions ORDER BY id').all<{id: string}>().filter(s => !DUPS.includes(s.id));
    migrate(conn);
    expect(conn.prepare('SELECT id, ended_at FROM sessions ORDER BY id').all()).toEqual(before);
    expect((sessOf(conn, 'live') as {ended_at: number | null}).ended_at).toBeNull();
  });

  it('leaves foreign_keys ON after the step', () => {
    const conn = v4Db();
    migrate(conn);
    expect(conn.getPragma('foreign_keys')).toBe(1);
  });
});

describe('runner integration', () => {
  it('asks for exactly one backup from v4: pre-session-integrity; from v3: pre-session-ended-at', () => {
    const b4 = vi.fn();
    migrate(v4Db(), b4);
    expect(b4.mock.calls).toEqual([['pre-session-integrity']]);

    const v3 = open();
    runMigrations(v3, MIGRATIONS.slice(0, 3), {backup: () => {}});
    v3.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('s', 's', '2026-10-01T00:00:00.000Z', '{}')").run();
    const b3 = vi.fn();
    migrate(v3, b3);
    expect(b3.mock.calls).toEqual([['pre-session-ended-at']]);
    expect(version(v3)).toBe(5);
    expect((sessOf(v3, 's') as {attribution: string}).attribution).toBe('legacy');
  });

  it('a second run is a no-op: no backup, version 5, identical schema and data', () => {
    const conn = v4Db();
    migrate(conn);
    const dump = () => ({
      schema:   conn.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
      sessions: conn.prepare('SELECT * FROM sessions ORDER BY id').all(),
      rows:     conn.prepare('SELECT * FROM session_maps ORDER BY id').all(),
      seq:      conn.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'session_maps'").get(),
    });
    const before = dump();
    const backup = vi.fn();
    migrate(conn, backup);
    expect(backup).not.toHaveBeenCalled();
    expect(version(conn)).toBe(5);
    expect(dump()).toEqual(before);
  });

  it('a throwing v5 rolls back to v4 whole, with foreign keys restored ON', () => {
    const conn   = v4Db();
    const schema = conn.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
    const rows   = conn.prepare('SELECT * FROM session_maps ORDER BY id').all();
    const sess   = conn.prepare('SELECT * FROM sessions ORDER BY id').all();
    const broken = [...UP_TO_V4, {...MIGRATIONS[4], up: (c: SqlConn) => { MIGRATIONS[4].up(c); throw new Error('late'); }}];
    expect(() => runMigrations(conn, broken, {backup: () => {}})).toThrow('late');
    expect(version(conn)).toBe(4);
    expect(conn.getPragma('foreign_keys')).toBe(1);
    expect(conn.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(schema);
    expect(conn.prepare('SELECT * FROM session_maps ORDER BY id').all()).toEqual(rows);
    expect(conn.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(sess);
  });

  it('a fresh DB gets the v5 schema without a backup', () => {
    const conn   = open();
    const backup = vi.fn();
    migrate(conn, backup);
    expect(backup).not.toHaveBeenCalled();
    expect(version(conn)).toBe(5);
    expect(hasTable(conn, 'seasonal_stats')).toBe(false);
    expect(columns(conn, 'wealth_datapoints')).not.toContain('session_id');
    expect(conn.prepare('PRAGMA foreign_key_list(session_maps)').all()).toHaveLength(1);
  });
});
