/**
 * Migration v3 `row-ended-at` against hostile v2 data: extreme and corrupt
 * durations, an empty DB, reruns, a DB already at v3, a malformed row, and a
 * column that is already there.
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

const V2 = MIGRATIONS.slice(0, 2);
const version = (c: SqlConn) => Number(c.getPragma('user_version'));
const migrate = (c: SqlConn, backup: (r: string) => void = () => {}) => runMigrations(c, MIGRATIONS, {backup});

function v2Db(): SqlConn {
  const c = open();
  runMigrations(c, V2, {backup: () => {}});
  c.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('s', 's', '2026-10-01T00:00:00.000Z', '{}')").run();
  return c;
}

function addRow(c: SqlConn, idx: number, start: number, duration: number, drops = '{}'): void {
  c.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
             VALUES ('s', ?, ?, ?, ?, '{}', NULL, NULL, NULL)`).run(idx, start, duration, drops);
}

const ended = (c: SqlConn) =>
  c.prepare('SELECT map_index AS i, started_at AS s, duration AS d, ended_at AS e FROM session_maps ORDER BY map_index')
    .all<{i: number; s: number; d: number; e: number}>();

describe('v3 backfill on extreme values', () => {
  it('is exact up to 2^53 - 1 and for a zero duration', () => {
    const c = v2Db();
    addRow(c, 1, 2 ** 52, 2 ** 52 - 1);
    addRow(c, 2, 1_800_000_000_000, 0);
    addRow(c, 3, 0, 0);
    addRow(c, 4, 1_800_000_000_000, 86_400_000 * 365 * 1000);   // a thousand-year run
    migrate(c);
    expect(ended(c).map(r => r.e)).toEqual([2 ** 53 - 1, 1_800_000_000_000, 0, 1_800_000_000_000 + 86_400_000 * 365 * 1000]);
    for (const r of ended(c)) expect(r.e).toBe(r.s + r.d);
  });

  it('a negative (corrupt) duration still backfills start + duration, without throwing', () => {
    const c = v2Db();
    addRow(c, 1, 1_000_000, -250);
    migrate(c);
    expect(ended(c)).toEqual([{i: 1, s: 1_000_000, d: -250, e: 999_750}]);
  });
});

describe('v3 on small and already-migrated databases', () => {
  it('a v2 DB with 0 rows migrates: column added, count 0 logged, version 3, one backup', () => {
    const c = v2Db();
    const backup = vi.fn();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(c, backup);
    expect(version(c)).toBe(3);
    expect(backup.mock.calls).toEqual([['pre-row-ended-at']]);
    expect(c.prepare('PRAGMA table_info(session_maps)').all<{name: string}>().some(x => x.name === 'ended_at')).toBe(true);
    expect(info.mock.calls.some(([, msg]) => String(msg).includes('0 rows backfilled'))).toBe(true);
  });

  it('a second run is a no-op: no backup, no rewrite of a row finish', () => {
    const c = v2Db();
    addRow(c, 1, 1_000, 500);
    migrate(c);
    c.prepare('UPDATE session_maps SET ended_at = 999999 WHERE map_index = 1').run();   // a post-v3 frozen run
    const backup = vi.fn();
    migrate(c, backup);
    migrate(c, backup);
    expect(backup).not.toHaveBeenCalled();
    expect(version(c)).toBe(3);
    expect(ended(c)[0].e).toBe(999_999);
  });

  it('a DB opened at v3 and reopened keeps every row and adds nothing', () => {
    const c = open();
    migrate(c);
    c.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('s', 's', '2026-10-01T00:00:00.000Z', '{}')").run();
    c.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, ended_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
               VALUES ('s', 1, 10, 100, 5, '{}', '{}', NULL, NULL, NULL)`).run();
    const before = c.prepare('SELECT * FROM session_maps').all<Record<string, unknown>>();
    const backup = vi.fn();
    migrate(c, backup);
    expect(backup).not.toHaveBeenCalled();
    expect(c.prepare('SELECT * FROM session_maps').all<Record<string, unknown>>()).toEqual(before);
    expect(c.prepare('PRAGMA table_info(session_maps)').all<{name: string}>().filter(x => x.name === 'ended_at')).toHaveLength(1);
  });
});

describe('v3 is pure SQL', () => {
  it('backfills a row whose drops are malformed JSON, without parsing it', () => {
    const c = v2Db();
    addRow(c, 1, 5_000, 1_000, '{{not json');
    addRow(c, 2, 9_000, 2_000);
    migrate(c);
    expect(ended(c).map(r => r.e)).toEqual([6_000, 11_000]);
    expect(c.prepare('SELECT drops FROM session_maps WHERE map_index = 1').get<{drops: string}>()?.drops).toBe('{{not json');
  });

  it('a v2 DB that already has the ended_at column (default 0) is still backfilled', () => {
    const c = v2Db();
    c.exec('ALTER TABLE session_maps ADD COLUMN ended_at INTEGER NOT NULL DEFAULT 0');
    addRow(c, 1, 7_000, 3_000);
    migrate(c);
    expect(version(c)).toBe(3);
    expect(ended(c)[0].e).toBe(10_000);
  });
});
