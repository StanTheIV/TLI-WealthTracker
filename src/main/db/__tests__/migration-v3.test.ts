/**
 * Migration v3 `row-ended-at`: `session_maps.ended_at INTEGER NOT NULL`,
 * backfilled as `started_at + duration`. Every row written before v3 derived
 * its start as `finish − duration` (integer ms), so the sum is the finish —
 * exactly, also for runs that froze or went dormant.
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

const UP_TO_V2 = MIGRATIONS.slice(0, 2);
const LATEST   = MIGRATIONS[MIGRATIONS.length - 1].version;
const T = Date.UTC(2026, 9, 1, 12);

/** Rows as a pre-v3 build saved them: `started_at = finish − duration`. */
const FIXTURE = [
  {session: 's1', mapIndex: 1, finish: T + 465_500, duration: 131_250, seasonal: null,      parent: null},  // map frozen by an Arcana interlude
  {session: 's1', mapIndex: 1, finish: T + 451_000, duration: 268_500, seasonal: 'arcana',  parent: 1},     // its overlap
  {session: 's1', mapIndex: 2, finish: T + 700_000, duration: 60_000,  seasonal: null,      parent: null},  // never frozen
  {session: 's2', mapIndex: 1, finish: T + 900_000, duration: 45_000,  seasonal: 'sandlord', parent: null}, // standalone hub run
  {session: 's2', mapIndex: 2, finish: T + 905_000, duration: 0,       seasonal: null,      parent: null},  // zero-length
] as const;

function insertFixture(conn: SqlConn): void {
  for (const id of ['s1', 's2']) {
    conn.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES (?, ?, '2026-10-01T00:00:00.000Z', '{}')").run(id, id);
  }
  for (const r of FIXTURE) {
    conn.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
                  VALUES (?, ?, ?, ?, '{"100":1}', '{}', ?, ?, NULL)`)
      .run(r.session, r.mapIndex, r.finish - r.duration, r.duration, r.seasonal, r.parent);
  }
}

/** A DB exactly as v2 left it, holding the fixture. */
function v2Db(): SqlConn {
  const conn = open();
  runMigrations(conn, UP_TO_V2, {backup: () => {}});
  insertFixture(conn);
  return conn;
}

const version  = (c: SqlConn) => Number(c.getPragma('user_version'));
const dumpRows = (c: SqlConn) => c.prepare('SELECT * FROM session_maps ORDER BY id').all<Record<string, unknown>>();
const migrate  = (c: SqlConn, backup: (r: string) => void = () => {}) => runMigrations(c, MIGRATIONS, {backup});

describe('MIGRATIONS[2]', () => {
  it('is v3 row-ended-at with the pre-row-ended-at backup, followed by v4 as the latest step', () => {
    expect(MIGRATIONS[2]).toMatchObject({version: 3, name: 'row-ended-at', backup: 'pre-row-ended-at'});
    expect(MIGRATIONS).toHaveLength(4);
  });
});

describe('v2 -> v3 on the fixture', () => {
  it('adds session_maps.ended_at as INTEGER NOT NULL and runs on to the latest user_version', () => {
    const conn = v2Db();
    migrate(conn);
    expect(version(conn)).toBe(LATEST);
    const col = conn.prepare('PRAGMA table_info(session_maps)').all<{name: string; type: string; notnull: number}>()
      .find(c => c.name === 'ended_at');
    expect(col).toMatchObject({type: 'INTEGER', notnull: 1});
  });

  it('backfills every row with its exact finish, never the default', () => {
    const conn = v2Db();
    migrate(conn);
    const ended = conn.prepare('SELECT ended_at FROM session_maps ORDER BY id').all<{ended_at: number}>().map(r => r.ended_at);
    expect(ended).toEqual(FIXTURE.map(r => r.finish));
    expect(conn.prepare('SELECT COUNT(*) AS n FROM session_maps WHERE ended_at IS NULL OR ended_at != started_at + duration').get())
      .toEqual({n: 0});
  });

  it('changes nothing else: every other column keeps its raw value, row count unchanged', () => {
    const conn   = v2Db();
    const before = dumpRows(conn);
    migrate(conn);
    const after = dumpRows(conn);
    expect(after).toHaveLength(FIXTURE.length);
    expect(after.map(({ended_at: _e, ...rest}) => rest)).toEqual(before);
    expect(conn.prepare('SELECT * FROM sessions ORDER BY id').all()).toHaveLength(2);
  });

  it('the store reads each row\'s finish back as endedAt', () => {
    const conn = v2Db();
    migrate(conn);
    const rows = new SqliteSessionStore(conn).getRows('s1');
    expect(rows.map(r => [r.startedAt, r.endedAt, r.duration])).toEqual(
      FIXTURE.filter(r => r.session === 's1').map(r => [r.finish - r.duration, r.finish, r.duration]),
    );
  });

  it('logs the backfilled row count', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(v2Db());
    expect(info).toHaveBeenCalledWith('database', `Row finish migration: ${FIXTURE.length} rows backfilled`);
  });

  it('asks for exactly one backup, pre-row-ended-at', () => {
    const backup = vi.fn();
    migrate(v2Db(), backup);
    expect(backup.mock.calls).toEqual([['pre-row-ended-at']]);
  });

  it('a second run is a no-op: no backup, latest version, identical data — rows written after v3 keep their own finish', () => {
    const conn = v2Db();
    migrate(conn);
    // A frozen run saved by this build: its finish is past started_at + duration.
    new SqliteSessionStore(conn).insertRows([{
      sessionId: 's2', mapIndex: 3, startedAt: T + 1_000_000, endedAt: T + 1_300_000, duration: 60_000,
      drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null,
    }]);
    const rows = dumpRows(conn);

    const backup = vi.fn();
    migrate(conn, backup);

    expect(backup).not.toHaveBeenCalled();
    expect(version(conn)).toBe(LATEST);
    expect(dumpRows(conn)).toEqual(rows);
    expect(rows[rows.length - 1].ended_at).toBe(T + 1_300_000);
  });
});

describe('v0, v1 and fresh databases', () => {
  it('a v0 DB with data runs every step in one run with ONE backup (pre-versioned-migrations)', () => {
    const conn = open();
    MIGRATIONS[0].up(conn);
    conn.setPragma('user_version', 0);
    insertFixture(conn);
    const backup = vi.fn();

    migrate(conn, backup);

    expect(backup.mock.calls).toEqual([['pre-versioned-migrations']]);
    expect(version(conn)).toBe(LATEST);
    expect(conn.prepare('SELECT ended_at FROM session_maps ORDER BY id').all<{ended_at: number}>().map(r => r.ended_at))
      .toEqual(FIXTURE.map(r => r.finish));
  });

  it('a v1 DB runs v2 onwards with ONE backup (pre-cost-migration)', () => {
    const conn = open();
    runMigrations(conn, MIGRATIONS.slice(0, 1), {backup: () => {}});
    insertFixture(conn);
    const backup = vi.fn();

    migrate(conn, backup);

    expect(backup.mock.calls).toEqual([['pre-cost-migration']]);
    expect(version(conn)).toBe(LATEST);
    expect(conn.prepare('SELECT COUNT(*) AS n FROM session_maps WHERE ended_at != started_at + duration').get()).toEqual({n: 0});
  });

  it('a fresh DB gets the column, no backup, no rows', () => {
    const conn   = open();
    const backup = vi.fn();
    migrate(conn, backup);

    expect(backup).not.toHaveBeenCalled();
    expect(version(conn)).toBe(LATEST);
    expect(conn.prepare('PRAGMA table_info(session_maps)').all<{name: string}>().map(c => c.name)).toContain('ended_at');
    expect(dumpRows(conn)).toEqual([]);
  });
});
