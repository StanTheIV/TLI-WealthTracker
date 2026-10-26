import {log} from '../logger';
import type {SqlConn} from './sql-conn';

/**
 * Versioned schema migrations, tracked in `PRAGMA user_version`.
 *
 * Append only: never edit or renumber a shipped migration — add a new one.
 * Each step runs `up` and the version bump in one transaction, so a failure
 * leaves the DB at the last good version.
 */
export interface Migration {
  version: number;
  name:    string;
  /** Snapshot the DB before this step (reason becomes part of the backup dir name). */
  backup?: string;
  /** Run with foreign keys off (table rebuilds); FK integrity is checked before commit. */
  foreignKeysOff?: boolean;
  up(conn: SqlConn): void;
}

export interface MigrateOptions {
  /** Called at most once per run, before any step, and only for an existing DB. */
  backup: (reason: string) => void;
}

/** Add `column` to `table` unless it is already there. `ddl` is the column definition. */
export function ensureColumn(conn: SqlConn, table: string, column: string, ddl: string): void {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all<{name: string}>();
  if (cols.some(c => c.name === column)) return;
  conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function hasUserTables(conn: SqlConn): boolean {
  const row = conn.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get<{n: number}>();
  return (row?.n ?? 0) > 0;
}

/** What one `runMigrations` call found and did. */
export interface MigrationResult {
  /** `user_version` before the run. */
  from:         number;
  /** `user_version` after the run (`from` when nothing was pending or the DB is newer). */
  to:           number;
  /** Highest version this app knows (0 for an empty migration list). */
  latest:       number;
  /** `from > latest`: a newer app wrote this DB. Nothing was run, written or backed up. */
  newerThanApp: boolean;
}

/**
 * Apply every migration above the DB's `user_version`, in order. Throws on the first failure.
 * A DB newer than the latest known version is left untouched and reported via `newerThanApp`
 * (warn and continue — the caller tells the user).
 */
export function runMigrations(conn: SqlConn, migrations: readonly Migration[], opts: MigrateOptions): MigrationResult {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version <= migrations[i - 1].version) {
      throw new Error(`Migration versions must be strictly increasing: ${migrations[i - 1].version} → ${migrations[i].version}`);
    }
  }

  const from   = Number(conn.getPragma('user_version'));
  const latest = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;
  if (from > latest) {
    log.warn('database', `Schema v${from} is newer than this app knows (v${latest}); not migrating`);
    return {from, to: from, latest, newerThanApp: true};
  }
  const pending = migrations.filter(m => m.version > from);
  if (pending.length === 0) return {from, to: from, latest, newerThanApp: false};

  const backupStep = pending.find(m => m.backup);
  if (backupStep?.backup && hasUserTables(conn)) opts.backup(backupStep.backup);

  for (const m of pending) {
    // Toggled outside the transaction: the pragma is a no-op inside one.
    const fkWasOn = m.foreignKeysOff && Number(conn.getPragma('foreign_keys')) === 1;
    if (m.foreignKeysOff) conn.setPragma('foreign_keys', 'OFF');
    try {
      conn.transaction(() => {
        m.up(conn);
        // Checked before commit so a violating step rolls back with everything else.
        if (m.foreignKeysOff) {
          const violations = conn.prepare('PRAGMA foreign_key_check').all();
          if (violations.length > 0) {
            throw new Error(`Migration v${m.version} (${m.name}) left ${violations.length} foreign key violations`);
          }
        }
        conn.setPragma('user_version', m.version);
      });
    } finally {
      if (fkWasOn) conn.setPragma('foreign_keys', 'ON');
    }
    log.info('database', `Migrated schema to v${m.version} (${m.name})`);
  }
  return {from, to: latest, latest, newerThanApp: false};
}

// ---------------------------------------------------------------------------
// App migrations
// ---------------------------------------------------------------------------

/** The pre-versioning CREATE block, byte-for-byte (sqlite_master keeps the text). */
const V1_SCHEMA = `
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT '',
      price      REAL NOT NULL DEFAULT 0,
      price_date REAL NOT NULL DEFAULT 0,
      locked     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      saved_at        TEXT NOT NULL,
      total_time      REAL NOT NULL DEFAULT 0,
      map_time        REAL NOT NULL DEFAULT 0,
      map_count       INTEGER NOT NULL DEFAULT 0,
      drops           TEXT NOT NULL DEFAULT '{}',
      drops_by_source TEXT NOT NULL DEFAULT '{}',
      attribution     TEXT NOT NULL DEFAULT '',
      price_snapshot  TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS seasonal_stats (
      zone_type    TEXT PRIMARY KEY,
      zone_count   INTEGER NOT NULL DEFAULT 0,
      total_time   REAL NOT NULL DEFAULT 0,
      total_income REAL NOT NULL DEFAULT 0,
      drop_list    TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS wealth_datapoints (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  REAL NOT NULL,
      value      REAL NOT NULL,
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_wealth_timestamp ON wealth_datapoints (timestamp);

    CREATE TABLE IF NOT EXISTS api_lookups (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      date      TEXT NOT NULL,
      item_id   TEXT NOT NULL,
      timestamp REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_filters (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      rules   TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS session_maps (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL,
      map_index        INTEGER NOT NULL,
      started_at       REAL NOT NULL,
      duration         REAL NOT NULL,
      drops            TEXT NOT NULL DEFAULT '{}',
      spent            TEXT NOT NULL DEFAULT '{}',
      seasonal_type    TEXT,
      parent_map_index INTEGER,
      phase            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_maps_session ON session_maps (session_id);

    -- Price history is market data: wealthClear() must never touch these tables.
    CREATE TABLE IF NOT EXISTS price_observations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id   TEXT NOT NULL,
      timestamp REAL NOT NULL,              -- ms epoch
      source    TEXT NOT NULL,              -- 'scrape' | 'manual' | 'backfill'
      price     REAL NOT NULL,              -- median (what items.price receives)
      n INTEGER, p10 REAL, p25 REAL, p75 REAL, p90 REAL, min_price REAL  -- scrape only; cache of child rows
    );
    CREATE INDEX IF NOT EXISTS idx_price_obs_item_ts ON price_observations (item_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_price_obs_ts ON price_observations (timestamp);

    CREATE TABLE IF NOT EXISTS price_listings (
      observation_id INTEGER NOT NULL REFERENCES price_observations(id) ON DELETE CASCADE,
      rank           INTEGER NOT NULL,      -- 0 = cheapest (log order is already ascending)
      price          REAL NOT NULL,
      PRIMARY KEY (observation_id, rank)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS leagues (
      id        TEXT PRIMARY KEY,           -- 'SS14' or 'user-<ts>'
      name      TEXT NOT NULL,
      starts_at REAL NOT NULL,
      source    TEXT NOT NULL               -- 'bundled' | 'remote' | 'user'
    );
  `;

export const MIGRATIONS: readonly Migration[] = [
  {
    // Everything before versioning: the original CREATE block plus the columns
    // that pre-versioning builds added with ALTER. Idempotent on any of those DBs.
    version: 1,
    name:    'baseline',
    backup:  'pre-versioned-migrations',
    up(conn) {
      conn.exec(V1_SCHEMA);

      // Only ever added by ALTER — fresh DBs get it here too.
      ensureColumn(conn, 'wealth_datapoints', 'breakdown', "TEXT NOT NULL DEFAULT '{}'");

      // In the CREATE block above, but ancient DBs predate them.
      ensureColumn(conn, 'items', 'price_date', 'REAL NOT NULL DEFAULT 0');
      ensureColumn(conn, 'items', 'locked',     'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(conn, 'session_maps', 'seasonal_type',    'TEXT');
      ensureColumn(conn, 'session_maps', 'parent_map_index', 'INTEGER');
      // Existing sandlord rows keep phase=NULL, which readers must treat as 'hub':
      // in-map sandlord tracking didn't exist when they were written.
      ensureColumn(conn, 'session_maps', 'phase', 'TEXT');
      ensureColumn(conn, 'sessions', 'drops_by_source', "TEXT NOT NULL DEFAULT '{}'");
      // Existing rows keep attribution='' and are classified at read time from
      // drops_by_source (see rowToSession) — backfilling would be a lie, since the
      // engine era that wrote them can't be recovered from the row itself.
      ensureColumn(conn, 'sessions', 'attribution', "TEXT NOT NULL DEFAULT ''");
      // Existing rows keep price_snapshot='{}', which readers treat as "no snapshot"
      // and fall back to live prices for. Backfilling from today's prices would be a
      // lie — it would claim the session was worth at save time what it is worth now,
      // which is the exact drift the snapshot exists to expose.
      ensureColumn(conn, 'sessions', 'price_snapshot', "TEXT NOT NULL DEFAULT '{}'");
    },
  },
];
