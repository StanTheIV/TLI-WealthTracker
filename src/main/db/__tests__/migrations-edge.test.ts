/** Runner edge cases and v1-baseline equivalence with the pre-versioning (v0.19) schema code. */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations, type Migration} from '@/main/db/migrations';
import {initDb, getDb, settingsGet, settingsSet, itemsGetAll} from '@/main/db';
import {log} from '@/main/logger';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import {LEGACY_CREATE_SQL, LEGACY_ALTERS} from './fixtures/legacy-v019-schema';

const conns: SqlConn[] = [];
afterEach(() => { while (conns.length) conns.pop()!.close(); });

function open(): SqlConn {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  conns.push(conn);
  return conn;
}

const version = (c: SqlConn) => Number(c.getPragma('user_version'));
const tables  = (c: SqlConn) => c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
const step = (v: number, up: Migration['up'] = () => {}, extra: Partial<Migration> = {}): Migration => ({version: v, name: `m${v}`, up, ...extra});

describe('runner edge cases', () => {
  it('an empty migration list is a no-op (no backup, version untouched)', () => {
    const conn   = open();
    const backup = vi.fn();
    runMigrations(conn, [], {backup});
    expect(version(conn)).toBe(0);
    expect(backup).not.toHaveBeenCalled();
  });

  it('a DB newer than the app (user_version above the latest migration) is left alone and reported', () => {
    // Warn and continue: no error, no backup, no writes — the result tells the caller to warn the user.
    const conn = open();
    runMigrations(conn, MIGRATIONS, {backup: () => {}});
    conn.setPragma('user_version', 99);
    conn.exec('CREATE TABLE future_table (x)');
    const warn   = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const backup = vi.fn();
    const result = runMigrations(conn, MIGRATIONS, {backup});
    expect(result).toEqual({from: 99, to: 99, latest: MIGRATIONS[MIGRATIONS.length - 1].version, newerThanApp: true});
    expect(version(conn)).toBe(99);
    expect(backup).not.toHaveBeenCalled();
    expect(tables(conn)).toContainEqual({name: 'future_table'});
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('initDb on a newer-than-known DB reports it, does not crash or alter it, and the app keeps working', () => {
    const conn = open();
    runMigrations(conn, MIGRATIONS, {backup: () => {}});
    conn.setPragma('user_version', 7);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = initDb(conn, {backup: () => { throw new Error('no backup expected'); }});
    expect(result.newerThanApp).toBe(true);
    expect(result.from).toBe(7);
    expect(version(conn)).toBe(7);
    settingsSet('k', 'v');
    expect(settingsGet('k')).toBe('v');
    warn.mockRestore();
  });

  it('a step may use conn.transaction itself (nested -> savepoint), including a caught inner failure', () => {
    const conn = open();
    runMigrations(conn, [step(1, c => {
      c.exec('CREATE TABLE a (x)');
      c.transaction(() => { c.exec('INSERT INTO a VALUES (1)'); });
      try { c.transaction(() => { c.exec('INSERT INTO a VALUES (2)'); throw new Error('inner'); }); } catch { /* expected */ }
      c.exec('INSERT INTO a VALUES (3)');
    })], {backup: () => {}});
    expect(version(conn)).toBe(1);
    expect(conn.prepare('SELECT x FROM a ORDER BY x').all()).toEqual([{x: 1}, {x: 3}]);
  });

  it('a throw after a nested transaction committed still rolls back the whole step', () => {
    const conn = open();
    expect(() => runMigrations(conn, [step(1, c => {
      c.exec('CREATE TABLE a (x)');
      c.transaction(() => { c.exec('INSERT INTO a VALUES (1)'); });
      throw new Error('late');
    })], {backup: () => {}})).toThrow('late');
    expect(version(conn)).toBe(0);
    expect(tables(conn)).toEqual([]);
  });

  it('a throwing backup aborts before any migration runs and can be retried', () => {
    const conn = open();
    conn.exec('CREATE TABLE existing (x)');
    const ran = vi.fn();
    const migrations = [step(1, c => { ran(); c.exec('CREATE TABLE a (x)'); }, {backup: 'pre'})];
    expect(() => runMigrations(conn, migrations, {backup: () => { throw new Error('disk full'); }})).toThrow('disk full');
    expect(ran).not.toHaveBeenCalled();
    expect(version(conn)).toBe(0);
    expect(tables(conn)).toEqual([{name: 'existing'}]);

    runMigrations(conn, migrations, {backup: () => {}});
    expect(version(conn)).toBe(1);
  });

  it('a failing foreignKeysOff step restores foreign_keys = ON', () => {
    const conn = open();
    expect(() => runMigrations(conn, [step(1, () => { throw new Error('boom'); }, {foreignKeysOff: true})], {backup: () => {}})).toThrow('boom');
    expect(conn.getPragma('foreign_keys')).toBe(1);
    expect(version(conn)).toBe(0);
  });

  it('a foreignKeysOff step on a connection with FKs already off leaves them off', () => {
    const conn = open();
    conn.setPragma('foreign_keys', 'OFF');
    runMigrations(conn, [step(1, c => c.exec('CREATE TABLE a (x)'), {foreignKeysOff: true})], {backup: () => {}});
    expect(conn.getPragma('foreign_keys')).toBe(0);
  });

  it('only the first pending backup request fires, even when later steps also ask', () => {
    const conn = open();
    conn.exec('CREATE TABLE existing (x)');
    const backup = vi.fn();
    runMigrations(conn, [step(1, () => {}, {backup: 'one'}), step(2, () => {}, {backup: 'two'})], {backup});
    expect(backup.mock.calls).toEqual([['one']]);
  });
});

describe('v1 baseline vs the v0.19 schema code', () => {
  /** The schema changes after v1: v2 adds the session total cost, v3 the row finish, v4 the session end. */
  const POST_V1_DDL = "ALTER TABLE sessions ADD COLUMN spent TEXT NOT NULL DEFAULT '{}'; ALTER TABLE session_maps ADD COLUMN ended_at INTEGER NOT NULL DEFAULT 0; ALTER TABLE sessions ADD COLUMN ended_at INTEGER";

  const schema = (c: SqlConn) => c.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const dump   = (c: SqlConn) => Object.fromEntries(
    (tables(c) as {name: string}[]).map(t => [t.name, c.prepare(`SELECT * FROM ${t.name} ORDER BY 1, 2`).all()]),
  );

  /** Exactly what v0.19 initDb did: CREATE block, then every ALTER with errors swallowed. */
  function legacyDb(): SqlConn {
    const conn = open();
    conn.exec(LEGACY_CREATE_SQL);
    for (const sql of LEGACY_ALTERS) { try { conn.exec(sql); } catch { /* already exists */ } }
    return conn;
  }

  function seedAll(c: SqlConn): void {
    c.exec(`
      INSERT INTO settings VALUES ('k', 'v'), ('price_backfill_done', '1');
      INSERT INTO items VALUES ('100', 'Ember', 'ember', 1.5, 1700000000000, 1), ('200', 'Fossil', '', 0, 0, 0);
      INSERT INTO sessions VALUES ('s1', 'Run', '2026-10-01T00:00:00Z', 60, 50, 2, '{"100":3}', '{"map":{"100":3}}', 'exclusive', '{"100":1.5}');
      INSERT INTO seasonal_stats VALUES ('arcana', 2, 30, 4.5, '{"100":1}');
      INSERT INTO wealth_datapoints (timestamp, value, session_id, breakdown) VALUES (1, 10, 's1', '{"100":{}}'), (2, 11, NULL, '{}');
      INSERT INTO api_lookups (date, item_id, timestamp) VALUES ('2026-10-01', '100', 5);
      INSERT INTO item_filters VALUES ('f1', 'A', 1, '[]');
      INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
        VALUES ('s1', 0, 1, 2, '{}', '{}', 'sandlord', NULL, 'map'), ('s1', 1, 3, 4, '{}', '{}', NULL, NULL, NULL);
      INSERT INTO price_observations (item_id, timestamp, source, price, n, p10, min_price) VALUES ('100', 1, 'scrape', 1.5, 2, 1.4, 1.4);
      INSERT INTO price_listings VALUES (1, 0, 1.4), (1, 1, 1.6);
      INSERT INTO leagues VALUES ('SS14', 'S14', 1, 'bundled');
    `);
  }

  it('produces the identical sqlite_master (plus v2, v3, v4) and an unchanged data set from a real v0.19 DB', () => {
    const conn = legacyDb();
    seedAll(conn);
    expect(version(conn)).toBe(0);
    const dataBefore = dump(conn);
    const target     = legacyDb();
    target.exec(POST_V1_DDL);

    initDb(conn, {backup: () => {}});

    expect(version(conn)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    expect(schema(conn)).toEqual(schema(target));
    // Only differences allowed: the every-start empty-type normalisation,
    // v2's new column at its default (the seed has no row cost to move), and
    // v3's row finish backfilled as started_at + duration, and v4's session end as the parsed saved_at.
    const expected = structuredClone(dataBefore) as Record<string, Record<string, unknown>[]>;
    expected.items.find(i => i.id === '200')!.type = 'other';
    for (const s of expected.sessions) { s.spent = '{}'; s.ended_at = Date.parse(s.saved_at as string); }
    expect(expected.sessions.map(s => s.ended_at)).toEqual([Date.parse('2026-10-01T00:00:00Z')]);
    for (const r of expected.session_maps) r.ended_at = (r.started_at as number) + (r.duration as number);
    expect(expected.session_maps.map(r => r.ended_at)).toEqual([3, 7]);
    expect(dump(conn)).toEqual(expected);
    expect(itemsGetAll().find(i => i.id === '100')?.locked).toBe(true);
    expect(getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('a fresh DB gets the same sqlite_master as a fresh v0.19 DB plus v2, v3, v4', () => {
    const old = legacyDb();
    old.exec(POST_V1_DDL);
    const fresh = open();
    initDb(fresh, {backup: () => { throw new Error('fresh DB must not back up'); }});
    expect(schema(fresh)).toEqual(schema(old));
  });

  it('an ancient DB (columns missing, pre-ALTER) ends with the same columns as the v0.19 code produced', () => {
    // Build a DB the way a very old build would have: tables without the ALTER-era columns.
    const ancient = open();
    ancient.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', price REAL NOT NULL DEFAULT 0);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, saved_at TEXT NOT NULL, total_time REAL NOT NULL DEFAULT 0,
        map_time REAL NOT NULL DEFAULT 0, map_count INTEGER NOT NULL DEFAULT 0, drops TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE wealth_datapoints (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp REAL NOT NULL, value REAL NOT NULL, session_id TEXT);
      CREATE TABLE session_maps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, map_index INTEGER NOT NULL,
        started_at REAL NOT NULL, duration REAL NOT NULL, drops TEXT NOT NULL DEFAULT '{}', spent TEXT NOT NULL DEFAULT '{}');
      INSERT INTO items VALUES ('1', 'A', '', 2);
      INSERT INTO sessions VALUES ('s', 'S', 'x', 1, 1, 1, '{}');
    `);
    // The same DB, upgraded by the old code path.
    const old = open();
    old.exec(ancient.prepare("SELECT group_concat(sql, ';') AS s FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get<{s: string}>()!.s);
    old.exec("INSERT INTO items VALUES ('1', 'A', '', 2); INSERT INTO sessions VALUES ('s', 'S', 'x', 1, 1, 1, '{}')");
    old.exec(LEGACY_CREATE_SQL);
    for (const sql of LEGACY_ALTERS) { try { old.exec(sql); } catch { /* already exists */ } }
    old.exec(POST_V1_DDL);

    runMigrations(ancient, MIGRATIONS, {backup: () => {}});
    const cols = (c: SqlConn, t: string) => c.prepare(`PRAGMA table_info(${t})`).all();
    for (const t of ['items', 'sessions', 'wealth_datapoints', 'session_maps']) expect(cols(ancient, t), t).toEqual(cols(old, t));
    // saved_at 'x' is unparsable and the session has no rows: v4 falls back to 0, never NULL (NULL = live).
    expect(ancient.prepare('SELECT * FROM sessions').all())
      .toEqual(old.prepare('SELECT * FROM sessions').all().map(s => ({...s, ended_at: 0})));
    expect(ancient.prepare('SELECT * FROM items').all()).toEqual(old.prepare('SELECT * FROM items').all());
  });
});
