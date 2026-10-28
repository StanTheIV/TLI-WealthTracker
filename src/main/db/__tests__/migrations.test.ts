/**
 * Versioned migration runner + the v1 baseline, on the node:sqlite driver.
 * "v0.19-shaped" = the schema every pre-versioning build ended up with
 * (all tables and columns, user_version 0) — what real installs have today.
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations, ensureColumn, type Migration} from '@/main/db/migrations';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
/** The v1 baseline step alone — its "changes nothing on a v0.19 DB" contract is pinned in isolation. */
const V1_ONLY = MIGRATIONS.slice(0, 1);

const EXPECTED_COLUMNS: Record<string, string[]> = {
  settings:           ['key', 'value'],
  items:              ['id', 'name', 'type', 'price', 'price_date', 'locked'],
  sessions:           ['id', 'name', 'saved_at', 'total_time', 'map_time', 'map_count', 'drops', 'drops_by_source', 'attribution', 'price_snapshot', 'spent', 'ended_at'],
  seasonal_stats:     ['zone_type', 'zone_count', 'total_time', 'total_income', 'drop_list'],
  wealth_datapoints:  ['id', 'timestamp', 'value', 'session_id', 'breakdown'],
  api_lookups:        ['id', 'date', 'item_id', 'timestamp'],
  item_filters:       ['id', 'name', 'enabled', 'rules'],
  session_maps:       ['id', 'session_id', 'map_index', 'started_at', 'duration', 'drops', 'spent', 'seasonal_type', 'parent_map_index', 'phase', 'ended_at'],
  price_observations: ['id', 'item_id', 'timestamp', 'source', 'price', 'n', 'p10', 'p25', 'p75', 'p90', 'min_price'],
  price_listings:     ['observation_id', 'rank', 'price'],
  leagues:            ['id', 'name', 'starts_at', 'source'],
};
const EXPECTED_INDEXES = ['idx_price_obs_item_ts', 'idx_price_obs_ts', 'idx_session_maps_session', 'idx_wealth_timestamp'];

const conns: SqlConn[] = [];
afterEach(() => { while (conns.length) conns.pop()!.close(); });

function open(): SqlConn {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  conns.push(conn);
  return conn;
}

const noBackup = {backup: () => {}};

function tableNames(conn: SqlConn): string[] {
  return conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all<{name: string}>().map(r => r.name);
}

function tableInfo(conn: SqlConn, table: string) {
  return conn.prepare(`PRAGMA table_info(${table})`).all<{name: string; type: string; notnull: number; dflt_value: string | null; pk: number}>();
}

function schemaSql(conn: SqlConn) {
  return conn.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
}

function dumpData(conn: SqlConn): Record<string, unknown[]> {
  return Object.fromEntries(tableNames(conn).map(t => [t, conn.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));
}

/** What every pre-versioning build left behind: full schema, user_version 0. */
function v019Db(): SqlConn {
  const conn = open();
  MIGRATIONS[0].up(conn);
  conn.setPragma('user_version', 0);
  return conn;
}

function seed(conn: SqlConn): void {
  conn.exec(`
    INSERT INTO settings VALUES ('k', 'v');
    INSERT INTO items VALUES ('100', 'Ember', 'ember', 1.5, 1700000000000, 1);
    INSERT INTO sessions VALUES ('s1', 'Run', '2026-10-01T00:00:00Z', 60, 50, 2, '{"100":3}', '{"map":{"100":3}}', 'exclusive', '{"100":1.5}');
    INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
      VALUES ('s1', 0, 1, 2, '{}', '{}', 'sandlord', NULL, 'map');
    INSERT INTO wealth_datapoints (timestamp, value, session_id, breakdown) VALUES (1, 10, 's1', '{"100":{}}');
    INSERT INTO price_observations (item_id, timestamp, source, price, n) VALUES ('100', 1, 'scrape', 1.5, 2);
    INSERT INTO price_listings VALUES (1, 0, 1.4), (1, 1, 1.6);
    INSERT INTO leagues VALUES ('SS14', 'S14', 1, 'bundled');
  `);
}

describe('v1 baseline', () => {
  it('migrates a fresh DB to the latest version with the full schema, without a backup', () => {
    const conn   = open();
    const backup = vi.fn();
    runMigrations(conn, MIGRATIONS, {backup});

    expect(conn.getPragma('user_version')).toBe(LATEST);
    expect(tableNames(conn)).toEqual(Object.keys(EXPECTED_COLUMNS).sort());
    for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
      expect(tableInfo(conn, table).map(c => c.name), table).toEqual(cols);
    }
    const indexes = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{name: string}>().map(r => r.name);
    expect(indexes).toEqual(EXPECTED_INDEXES);
    expect(backup).not.toHaveBeenCalled();
  });

  it('takes a v0.19-shaped DB to v1 without changing schema or data, backing up once', () => {
    const conn = v019Db();
    seed(conn);
    const schemaBefore = schemaSql(conn);
    const dataBefore   = dumpData(conn);
    const backup       = vi.fn();

    runMigrations(conn, V1_ONLY, {backup});

    expect(conn.getPragma('user_version')).toBe(1);
    expect(schemaSql(conn)).toEqual(schemaBefore);
    expect(dumpData(conn)).toEqual(dataBefore);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(backup).toHaveBeenCalledWith('pre-versioned-migrations');
  });

  it('takes a v0.19-shaped DB to the latest version in one run, backing up once (v1, v2 and v3 share it)', () => {
    const conn = v019Db();
    seed(conn);
    const backup = vi.fn();

    runMigrations(conn, MIGRATIONS, {backup});

    expect(conn.getPragma('user_version')).toBe(LATEST);
    expect(backup.mock.calls).toEqual([['pre-versioned-migrations']]);
    // v2 only adds sessions.spent here: the seed has no row cost to move.
    expect(conn.prepare('SELECT drops, spent FROM sessions').all()).toEqual([{drops: '{"100":3}', spent: '{}'}]);
    // v3 backfills the row's finish from its derived start.
    expect(conn.prepare('SELECT started_at, duration, ended_at FROM session_maps').all()).toEqual([{started_at: 1, duration: 2, ended_at: 3}]);
  });

  it('adds the ALTER-era columns to an ancient DB with their defaults', () => {
    const conn = open();
    conn.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', price REAL NOT NULL DEFAULT 0);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, saved_at TEXT NOT NULL, total_time REAL NOT NULL DEFAULT 0,
        map_time REAL NOT NULL DEFAULT 0, map_count INTEGER NOT NULL DEFAULT 0, drops TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE session_maps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, map_index INTEGER NOT NULL,
        started_at REAL NOT NULL, duration REAL NOT NULL, drops TEXT NOT NULL DEFAULT '{}', spent TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE wealth_datapoints (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp REAL NOT NULL, value REAL NOT NULL, session_id TEXT);
      INSERT INTO items VALUES ('100', 'Ember', '', 1.5);
      INSERT INTO sessions VALUES ('s1', 'Run', '2026-01-01', 1, 1, 1, '{}');
      INSERT INTO session_maps (session_id, map_index, started_at, duration) VALUES ('s1', 0, 1, 2);
      INSERT INTO wealth_datapoints (timestamp, value) VALUES (1, 10);
    `);
    runMigrations(conn, MIGRATIONS, noBackup);

    expect(conn.getPragma('user_version')).toBe(LATEST);
    // Same end state as a fresh DB, column for column.
    const fresh = open();
    runMigrations(fresh, MIGRATIONS, noBackup);
    for (const table of Object.keys(EXPECTED_COLUMNS)) {
      expect(tableInfo(conn, table), table).toEqual(tableInfo(fresh, table));
    }
    expect(conn.prepare('SELECT * FROM items').get()).toEqual({id: '100', name: 'Ember', type: '', price: 1.5, price_date: 0, locked: 0});
    expect(conn.prepare('SELECT drops_by_source, attribution, price_snapshot, spent FROM sessions').get())
      .toEqual({drops_by_source: '{}', attribution: '', price_snapshot: '{}', spent: '{}'});
    // v4: saved_at '2026-01-01' parses (as UTC midnight) → ms epoch
    expect(conn.prepare('SELECT ended_at FROM sessions').get()).toEqual({ended_at: Date.parse('2026-01-01')});
    expect(conn.prepare('SELECT seasonal_type, parent_map_index, phase, ended_at FROM session_maps').get())
      .toEqual({seasonal_type: null, parent_map_index: null, phase: null, ended_at: 3});   // v3: started_at + duration
    expect(conn.prepare('SELECT breakdown FROM wealth_datapoints').get()).toEqual({breakdown: '{}'});
  });

  it('is a no-op when rerun', () => {
    const conn = v019Db();
    seed(conn);
    runMigrations(conn, MIGRATIONS, noBackup);
    const schema = schemaSql(conn);
    const data   = dumpData(conn);
    const backup = vi.fn();

    runMigrations(conn, MIGRATIONS, {backup});

    expect(conn.getPragma('user_version')).toBe(LATEST);
    expect(schemaSql(conn)).toEqual(schema);
    expect(dumpData(conn)).toEqual(data);
    expect(backup).not.toHaveBeenCalled();
  });
});

describe('runMigrations', () => {
  const step = (version: number, up: (c: SqlConn) => void, extra: Partial<Migration> = {}): Migration =>
    ({version, name: `v${version}`, up, ...extra});

  it('rolls back a failing step, keeps user_version at the last good one and stops', () => {
    const conn = open();
    const v3   = vi.fn();
    const migrations = [
      step(1, c => c.exec('CREATE TABLE a (x)')),
      step(2, c => { c.exec('CREATE TABLE b (x)'); throw new Error('boom'); }),
      step(3, v3),
    ];

    expect(() => runMigrations(conn, migrations, noBackup)).toThrow('boom');
    expect(conn.getPragma('user_version')).toBe(1);
    expect(tableNames(conn)).toEqual(['a']);
    expect(v3).not.toHaveBeenCalled();
  });

  it('only applies versions above user_version, in order', () => {
    const conn  = open();
    const order: number[] = [];
    conn.setPragma('user_version', 1);
    runMigrations(conn, [1, 2, 3].map(v => step(v, () => { order.push(v); })), noBackup);
    expect(order).toEqual([2, 3]);
    expect(conn.getPragma('user_version')).toBe(3);
  });

  it('backs up once before the first pending step that asks, only for an existing DB', () => {
    const migrations = [
      step(1, c => c.exec('CREATE TABLE IF NOT EXISTS a (x)'), {backup: 'first'}),
      step(2, c => c.exec('CREATE TABLE IF NOT EXISTS b (x)'), {backup: 'second'}),
    ];

    const fresh       = open();
    const freshBackup = vi.fn();
    runMigrations(fresh, migrations, {backup: freshBackup});
    expect(freshBackup).not.toHaveBeenCalled();

    const existing = open();
    existing.exec('CREATE TABLE a (x)');
    const seenVersion: unknown[] = [];
    const backup = vi.fn(() => { seenVersion.push(existing.getPragma('user_version')); });
    runMigrations(existing, migrations, {backup});
    expect(backup).toHaveBeenCalledTimes(1);
    expect(backup).toHaveBeenCalledWith('first');
    expect(seenVersion).toEqual([0]);   // before any step ran
  });

  it('runs a foreignKeysOff step that rebuilds a referenced table, then restores foreign keys', () => {
    const conn = open();
    conn.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
      INSERT INTO parent VALUES (1, 'p');
      INSERT INTO child VALUES (10, 1);
    `);
    const rebuild = step(1, c => {
      expect(c.getPragma('foreign_keys')).toBe(0);
      c.exec(`
        CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '');
        INSERT INTO parent_new SELECT id, name FROM parent;
        DROP TABLE parent;
        ALTER TABLE parent_new RENAME TO parent;
      `);
    }, {foreignKeysOff: true});

    runMigrations(conn, [rebuild], noBackup);

    expect(conn.getPragma('user_version')).toBe(1);
    expect(conn.getPragma('foreign_keys')).toBe(1);
    // With FKs on, DROP TABLE parent would have cascaded into child.
    expect(conn.prepare('SELECT id, pid FROM child').all()).toEqual([{id: 10, pid: 1}]);
  });

  it('rejects a foreignKeysOff step that leaves FK violations, rolling it back', () => {
    const conn = open();
    conn.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id));
    `);
    const orphan = step(1, c => c.exec('INSERT INTO child VALUES (1, 99)'), {foreignKeysOff: true});

    expect(() => runMigrations(conn, [orphan], noBackup)).toThrow(/foreign key/);
    expect(conn.getPragma('user_version')).toBe(0);
    expect(conn.prepare('SELECT COUNT(*) AS n FROM child').get()).toEqual({n: 0});
    expect(conn.getPragma('foreign_keys')).toBe(1);
  });

  it('rejects non-increasing versions before touching the DB', () => {
    const conn = open();
    const up   = vi.fn();
    expect(() => runMigrations(conn, [step(1, up), step(1, up)], noBackup)).toThrow(/strictly increasing/);
    expect(() => runMigrations(conn, [step(2, up), step(1, up)], noBackup)).toThrow(/strictly increasing/);
    expect(up).not.toHaveBeenCalled();
    expect(conn.getPragma('user_version')).toBe(0);
  });
});

describe('ensureColumn', () => {
  it('adds a missing column and leaves an existing one alone', () => {
    const conn = open();
    conn.exec('CREATE TABLE t (a TEXT)');
    ensureColumn(conn, 't', 'b', "TEXT NOT NULL DEFAULT 'x'");
    ensureColumn(conn, 't', 'b', "TEXT NOT NULL DEFAULT 'x'");
    expect(tableInfo(conn, 't').map(c => [c.name, c.dflt_value])).toEqual([['a', null], ['b', "'x'"]]);
  });

  it('surfaces real errors instead of swallowing them', () => {
    const conn = open();
    expect(() => ensureColumn(conn, 'missing', 'b', 'TEXT')).toThrow();
  });
});
