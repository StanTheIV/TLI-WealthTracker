/**
 * Migration v4 `session-ended-at`: `sessions.ended_at INTEGER` (nullable; NULL = a live
 * session), backfilled per row in JS as `Date.parse(saved_at)` in ms. An unparsable
 * saved_at must never stay NULL (that would read as live): it falls back to the
 * session's latest `session_maps.ended_at`, else 0.
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

const UP_TO_V3 = MIGRATIONS.slice(0, 3);
const LATEST   = MIGRATIONS[MIGRATIONS.length - 1].version;

/** saved_at as written by `new Date().toISOString()` (and the odd hand-written shapes). */
const FIXTURE = [
  {id: 's1', savedAt: '2026-10-01T00:00:00.000Z',   total: 3600.5, drops: '{"100":3}'},
  {id: 's2', savedAt: '2026-10-02T13:45:10.123Z',   total: 60,     drops: '{}'},
  {id: 's3', savedAt: '2026-01-01',                 total: 45,     drops: '{"7":1}'},   // date-only parses as UTC midnight
  {id: 's4', savedAt: '2026-10-03T10:00:00+02:00',  total: 1,      drops: '{}'},         // explicit offset
] as const;

function insertFixture(conn: SqlConn): void {
  for (const s of FIXTURE) {
    conn.prepare(`INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops, drops_by_source, attribution, price_snapshot, spent)
                  VALUES (?, ?, ?, ?, 10, 2, ?, '{"map":{"100":3}}', 'drop-through', '{"100":1.5}', '{"300":2}')`)
      .run(s.id, `Name ${s.id}`, s.savedAt, s.total, s.drops);
  }
  conn.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, ended_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
                VALUES ('s1', 1, 1000, 2000, 1000, '{"100":3}', '{}', NULL, NULL, NULL), ('s1', 1, 1100, 1900, 800, '{}', '{}', 'arcana', 1, NULL)`).run();
}

function v3Db(): SqlConn {
  const conn = open();
  runMigrations(conn, UP_TO_V3, {backup: () => {}});
  insertFixture(conn);
  return conn;
}

const version  = (c: SqlConn) => Number(c.getPragma('user_version'));
const migrate  = (c: SqlConn, backup: (r: string) => void = () => {}) => runMigrations(c, MIGRATIONS, {backup});
const dumpSess = (c: SqlConn) => c.prepare('SELECT * FROM sessions ORDER BY id').all<Record<string, unknown>>();
const dumpRows = (c: SqlConn) => c.prepare('SELECT * FROM session_maps ORDER BY id').all<Record<string, unknown>>();
const endedAts = (c: SqlConn) => c.prepare('SELECT id, ended_at FROM sessions ORDER BY id').all<{id: string; ended_at: number | null}>();

describe('MIGRATIONS[3]', () => {
  it('is v4 session-ended-at with the pre-session-ended-at backup, followed by v5', () => {
    expect(MIGRATIONS[3]).toMatchObject({version: 4, name: 'session-ended-at', backup: 'pre-session-ended-at'});
    expect(MIGRATIONS[4]?.version).toBe(5);
  });
});

describe('v3 -> v4 on the fixture', () => {
  it('adds sessions.ended_at as a nullable INTEGER with no default and runs on to the latest user_version', () => {
    const conn = v3Db();
    migrate(conn);
    expect(version(conn)).toBe(LATEST);
    const col = conn.prepare('PRAGMA table_info(sessions)').all<{name: string; type: string; notnull: number; dflt_value: string | null}>()
      .find(c => c.name === 'ended_at');
    expect(col).toMatchObject({type: 'INTEGER', notnull: 0, dflt_value: null});
  });

  it('backfills every session with Date.parse(saved_at) in ms, never NULL', () => {
    const conn = v3Db();
    migrate(conn);
    expect(endedAts(conn)).toEqual(FIXTURE.map(s => ({id: s.id, ended_at: Date.parse(s.savedAt)})));
    expect(conn.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL').get()).toEqual({n: 0});
    // ms, not seconds: far above any seconds epoch
    expect(endedAts(conn)[0].ended_at).toBe(Date.UTC(2026, 9, 1));
  });

  it('changes nothing else: every other column keeps its raw value, session_maps untouched', () => {
    const conn    = v3Db();
    const sBefore = dumpSess(conn);
    const rBefore = dumpRows(conn);
    migrate(conn);
    const sAfter = dumpSess(conn);
    expect(sAfter).toHaveLength(FIXTURE.length);
    expect(sAfter.map(({ended_at: _e, ...rest}) => rest)).toEqual(sBefore);
    expect(dumpRows(conn)).toEqual(rBefore);
  });

  it('the store reads the backfilled value back as endedAt', () => {
    const conn = v3Db();
    migrate(conn);
    const s = new SqliteSessionStore(conn).getSession('s2');
    expect(s?.endedAt).toBe(Date.parse('2026-10-02T13:45:10.123Z'));
  });

  it('logs the backfilled session count', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(v3Db());
    expect(info.mock.calls.some(([, msg]) => String(msg).includes(`${FIXTURE.length} session`))).toBe(true);
  });

  it('asks for exactly one backup, pre-session-ended-at', () => {
    const backup = vi.fn();
    migrate(v3Db(), backup);
    expect(backup.mock.calls).toEqual([['pre-session-ended-at']]);
  });

  it('a second run is a no-op: no backup, latest version, identical data; a live (NULL) session stays live', () => {
    const conn = v3Db();
    migrate(conn);
    conn.prepare("UPDATE sessions SET ended_at = NULL WHERE id = 's2'").run();   // a live session saved by this build
    conn.prepare("UPDATE sessions SET ended_at = 12345 WHERE id = 's3'").run();
    const before = dumpSess(conn);

    const backup = vi.fn();
    migrate(conn, backup);

    expect(backup).not.toHaveBeenCalled();
    expect(version(conn)).toBe(LATEST);
    expect(dumpSess(conn)).toEqual(before);
    expect(endedAts(conn).find(r => r.id === 's2')?.ended_at).toBeNull();
  });
});

describe('unparsable saved_at', () => {
  it('falls back to the latest session_maps.ended_at, else 0, and never stays NULL', () => {
    const conn = open();
    runMigrations(conn, UP_TO_V3, {backup: () => {}});
    for (const [id, savedAt] of [['withRows', 'garbage'], ['noRows', ''], ['alsoBad', 'Invalid Date']]) {
      conn.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES (?, ?, ?, '{}')").run(id, id, savedAt);
    }
    conn.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, ended_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
                  VALUES ('withRows', 1, 100, 500, 400, '{}', '{}', NULL, NULL, NULL),
                         ('withRows', 2, 600, 9000, 8000, '{}', '{}', NULL, NULL, NULL),
                         ('withRows', 2, 650, 700, 50, '{}', '{}', 'arcana', 2, NULL)`).run();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    migrate(conn);

    expect(endedAts(conn)).toEqual([
      {id: 'alsoBad',  ended_at: 0},
      {id: 'noRows',   ended_at: 0},
      {id: 'withRows', ended_at: 9000},
    ]);
    // The fallback is logged (warn or info), naming the session.
    const logged = [...warn.mock.calls, ...info.mock.calls].map(c => c.join(' '));
    expect(logged.some(m => m.includes('withRows'))).toBe(true);
  });

  it('mixed parsable and unparsable sessions: only the unparsable ones fall back', () => {
    const conn = v3Db();
    conn.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('bad', 'bad', 'nope', '{}')").run();
    migrate(conn);
    const e = endedAts(conn);
    expect(e.find(r => r.id === 'bad')?.ended_at).toBe(0);
    expect(e.find(r => r.id === 's1')?.ended_at).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
  });
});

describe('v0, v2 and fresh databases', () => {
  it('a v0 DB with data runs every step in one run with ONE backup (pre-versioned-migrations)', () => {
    const conn = open();
    MIGRATIONS[0].up(conn);
    conn.setPragma('user_version', 0);
    conn.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('s', 's', '2026-10-01T00:00:00.000Z', '{}')").run();
    const backup = vi.fn();

    migrate(conn, backup);

    expect(backup.mock.calls).toEqual([['pre-versioned-migrations']]);
    expect(version(conn)).toBe(LATEST);
    expect(endedAts(conn)).toEqual([{id: 's', ended_at: Date.UTC(2026, 9, 1)}]);
  });

  it('a v3 DB asks for pre-session-ended-at only; a v2 DB for pre-row-ended-at only', () => {
    const v3 = v3Db();
    const b3 = vi.fn();
    migrate(v3, b3);
    expect(b3.mock.calls).toEqual([['pre-session-ended-at']]);

    const v2 = open();
    runMigrations(v2, MIGRATIONS.slice(0, 2), {backup: () => {}});
    v2.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('s', 's', '2026-10-01T00:00:00.000Z', '{}')").run();
    const b2 = vi.fn();
    migrate(v2, b2);
    expect(b2.mock.calls).toEqual([['pre-row-ended-at']]);
    expect(version(v2)).toBe(LATEST);
  });

  it('a fresh DB gets the column, no backup, no rows', () => {
    const conn   = open();
    const backup = vi.fn();
    migrate(conn, backup);

    expect(backup).not.toHaveBeenCalled();
    expect(version(conn)).toBe(LATEST);
    expect(conn.prepare('PRAGMA table_info(sessions)').all<{name: string}>().map(c => c.name)).toContain('ended_at');
    expect(dumpSess(conn)).toEqual([]);
  });
});
