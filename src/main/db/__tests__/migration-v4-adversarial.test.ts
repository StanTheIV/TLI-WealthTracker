/**
 * Migration v4 `session-ended-at` against hostile v3 data: odd saved_at shapes, extreme
 * values, an empty table, a pre-existing column, and a new-build live session.
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import type {SqlConn} from '@/main/db/sql-conn';
import {log} from '@/main/logger';
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

const V3 = MIGRATIONS.slice(0, 3);
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const version = (c: SqlConn) => Number(c.getPragma('user_version'));
const migrate = (c: SqlConn, backup: (r: string) => void = () => {}) => runMigrations(c, MIGRATIONS, {backup});

function v3Db(): SqlConn {
  const c = open();
  runMigrations(c, V3, {backup: () => {}});
  return c;
}
const addSession = (c: SqlConn, id: string, savedAt: string) =>
  c.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES (?, ?, ?, '{}')").run(id, id, savedAt);
const ended = (c: SqlConn) =>
  Object.fromEntries(c.prepare('SELECT id, ended_at FROM sessions').all<{id: string; ended_at: number | null}>().map(r => [r.id, r.ended_at]));

describe('v4 backfill on odd saved_at values', () => {
  it('parses what Date.parse parses (offsets, no-ms, leap day) and is integer ms', () => {
    const c = v3Db();
    const cases: Record<string, string> = {
      leap:   '2028-02-29T23:59:59.999Z',
      noMs:   '2026-10-01T00:00:00Z',
      offset: '2026-10-01T00:00:00-05:00',
      epoch:  '1970-01-01T00:00:00.000Z',
    };
    for (const [id, sa] of Object.entries(cases)) addSession(c, id, sa);
    migrate(c);
    const e = ended(c);
    for (const [id, sa] of Object.entries(cases)) expect(e[id], id).toBe(Date.parse(sa));
    expect(e.epoch).toBe(0);
    expect(Number.isInteger(e.leap)).toBe(true);
  });

  it('a pre-1970 saved_at backfills a negative ms value, not NULL and not 0', () => {
    const c = v3Db();
    addSession(c, 'old', '1969-12-31T23:59:59.000Z');
    migrate(c);
    expect(ended(c).old).toBe(-1000);
  });

  it('unparsable shapes (empty, whitespace, SQL-ish, unicode, out-of-range) all end non-NULL', () => {
    const c = v3Db();
    const bad = ['', '   ', "'; DROP TABLE sessions; --", '日本語', 'NaN', '2026-13-45T00:00:00Z'];
    bad.forEach((sa, i) => addSession(c, `b${i}`, sa));
    migrate(c);
    expect(c.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL').get()).toEqual({n: 0});
    for (let i = 0; i < bad.length; i++) expect(ended(c)[`b${i}`], bad[i]).toBe(0);
    expect(c.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({n: bad.length});
  });

  it('the row fallback uses the MAX ended_at across primary and overlap rows, and ignores other sessions rows', () => {
    const c = v3Db();
    addSession(c, 'a', 'bad');
    addSession(c, 'b', 'bad');
    c.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, ended_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
               VALUES ('a', 1, 1, 50, 49, '{}', '{}', NULL, NULL, NULL), ('a', 1, 1, 80, 79, '{}', '{}', 'arcana', 1, NULL),
                      ('b', 1, 1, 7, 6, '{}', '{}', NULL, NULL, NULL), ('zzz', 1, 1, 99999, 1, '{}', '{}', NULL, NULL, NULL)`).run();
    migrate(c);
    expect(ended(c)).toEqual({a: 80, b: 7});
  });
});

describe('v4 on small and already-migrated databases', () => {
  it('a v3 DB with 0 sessions migrates: column added, latest version, one pre-session-ended-at backup, count 0 logged', () => {
    const c = v3Db();
    const backup = vi.fn();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(c, backup);
    expect(version(c)).toBe(LATEST);
    expect(backup.mock.calls).toEqual([['pre-session-ended-at']]);
    expect(c.prepare('PRAGMA table_info(sessions)').all<{name: string}>().some(x => x.name === 'ended_at')).toBe(true);
    expect(info.mock.calls.some(([, msg]) => String(msg).includes('0 session'))).toBe(true);
  });

  it('a v3 DB that already has sessions.ended_at (nullable) is still backfilled, once', () => {
    const c = v3Db();
    c.exec('ALTER TABLE sessions ADD COLUMN ended_at INTEGER');
    addSession(c, 'a', '2026-10-01T00:00:00.000Z');
    migrate(c);
    expect(version(c)).toBe(LATEST);
    expect(ended(c).a).toBe(Date.UTC(2026, 9, 1));
    expect(c.prepare('PRAGMA table_info(sessions)').all<{name: string}>().filter(x => x.name === 'ended_at')).toHaveLength(1);
  });

  it('a DB at v4 holding a live (NULL) session is not touched by another run', () => {
    const c = v3Db();
    migrate(c);
    addSession(c, 'live', '2026-10-01T00:00:00.000Z');   // inserted by this build: ended_at NULL
    addSession(c, 'done', '2026-10-01T00:00:00.000Z');
    c.prepare("UPDATE sessions SET ended_at = 42 WHERE id = 'done'").run();
    const before = c.prepare('SELECT * FROM sessions ORDER BY id').all();
    const backup = vi.fn();
    migrate(c, backup);
    migrate(c, backup);
    expect(backup).not.toHaveBeenCalled();
    expect(c.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(before);
    expect(ended(c)).toEqual({live: null, done: 42});
  });

  it('a malformed JSON column in a session does not break the backfill (v4 only reads saved_at)', () => {
    const c = v3Db();
    c.prepare("INSERT INTO sessions (id, name, saved_at, drops, drops_by_source, spent) VALUES ('m', 'm', '2026-10-01T00:00:00.000Z', '{{bad', 'also bad', '???')").run();
    migrate(c);
    expect(ended(c).m).toBe(Date.UTC(2026, 9, 1));
    expect(c.prepare("SELECT drops, drops_by_source, spent FROM sessions WHERE id = 'm'").get())
      .toEqual({drops: '{{bad', drops_by_source: 'also bad', spent: '???'});
  });

  it('the backfill is atomic with the version bump: a throwing step leaves v3 and no half-filled column', () => {
    const c = v3Db();
    addSession(c, 'a', '2026-10-01T00:00:00.000Z');
    const broken = [...V3, {...MIGRATIONS[3], up: (conn: SqlConn) => { MIGRATIONS[3].up(conn); throw new Error('late'); }}];
    expect(() => runMigrations(c, broken, {backup: () => {}})).toThrow('late');
    expect(version(c)).toBe(3);
    expect(c.prepare('PRAGMA table_info(sessions)').all<{name: string}>().some(x => x.name === 'ended_at')).toBe(false);
  });
});
