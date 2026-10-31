import {log} from '../logger';
import type {SqlConn} from './sql-conn';
import {migrateSessionCost} from './migrations/cost-v2';

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
      // Existing rows keep attribution='' here; v5 classifies them from
      // drops_by_source (read-time inference until then).
      ensureColumn(conn, 'sessions', 'attribution', "TEXT NOT NULL DEFAULT ''");
      // Existing rows keep price_snapshot='{}', which readers treat as "no snapshot"
      // and fall back to live prices for. Backfilling from today's prices would be a
      // lie — it would claim the session was worth at save time what it is worth now,
      // which is the exact drift the snapshot exists to expose.
      ensureColumn(conn, 'sessions', 'price_snapshot', "TEXT NOT NULL DEFAULT '{}'");
    },
  },
  {
    // Entry cost moves off the drops: it lived there as negatives (and as a
    // positive copy in the row's `spent`); now it lives only in `spent`, on the
    // map row and on the new `sessions.spent` total. See migrations/cost-v2.ts
    // for the rules and the cases it cannot repair.
    version: 2,
    name:    'cost-on-map',
    backup:  'pre-cost-migration',
    up(conn) {
      ensureColumn(conn, 'sessions', 'spent', "TEXT NOT NULL DEFAULT '{}'");

      const sessions = conn.prepare('SELECT id, drops, drops_by_source, attribution FROM sessions ORDER BY id')
        .all<{id: string; drops: string; drops_by_source: string; attribution: string}>();
      const selectRows    = conn.prepare('SELECT id, drops, spent, parent_map_index FROM session_maps WHERE session_id = ? ORDER BY id');
      const updateRow     = conn.prepare('UPDATE session_maps SET drops = ?, spent = ? WHERE id = ?');
      const updateSession = conn.prepare('UPDATE sessions SET drops = ?, drops_by_source = ?, spent = ? WHERE id = ?');

      let rowsMigrated = 0, staleRowsCleared = 0, sessionsTouched = 0;
      for (const s of sessions) {
        const rows = selectRows.all<{id: number; drops: string; spent: string; parent_map_index: number | null}>(s.id);
        const out = migrateSessionCost(
          {drops: JSON.parse(s.drops), dropsBySource: JSON.parse(s.drops_by_source), attribution: s.attribution},
          rows.map(r => ({id: r.id, drops: JSON.parse(r.drops), spent: JSON.parse(r.spent), isPrimary: r.parent_map_index === null})),
        );
        for (const r of out.rows) updateRow.run(JSON.stringify(r.drops), JSON.stringify(r.spent), r.id);
        // The session changes exactly when some row's cost was added back.
        if (Object.keys(out.session.spent).length > 0) {
          updateSession.run(
            JSON.stringify(out.session.drops), JSON.stringify(out.session.dropsBySource),
            JSON.stringify(out.session.spent), s.id,
          );
        }
        if (out.rows.length > 0) sessionsTouched++;
        if (out.stats.staleRowsCleared > 0) {
          log.info('database', `Cost migration: session ${s.id}: cleared ${out.stats.staleRowsCleared} stale spent row(s)`);
        }
        rowsMigrated     += out.stats.rowsMigrated;
        staleRowsCleared += out.stats.staleRowsCleared;
      }
      log.info('database',
        `Cost migration: ${rowsMigrated} rows migrated, ${staleRowsCleared} stale rows cleared, ${sessionsTouched} sessions touched`);
    },
  },
  {
    // A row stores its run's finish: with real start times, `started_at +
    // duration` falls short of it for a run that froze or went dormant. Rows
    // written before this step derived their start as `finish − duration`, so
    // for them the sum IS the finish. ALTER needs a default for NOT NULL; the
    // backfill overwrites it on every existing row in this same step.
    version: 3,
    name:    'row-ended-at',
    backup:  'pre-row-ended-at',
    up(conn) {
      ensureColumn(conn, 'session_maps', 'ended_at', 'INTEGER NOT NULL DEFAULT 0');
      const {changes} = conn.prepare('UPDATE session_maps SET ended_at = started_at + duration').run();
      log.info('database', `Row finish migration: ${changes} rows backfilled`);
    },
  },
  {
    // A session stores its end; NULL marks it live. Every session before this
    // step was saved at Stop, so it ended at its save — the parsed `saved_at`
    // (an over-estimate: the save comes after the last map). Parsed in JS per
    // row: SQLite's date functions don't read every shape `Date.parse` does.
    // An unparsable saved_at must not stay NULL (it would read as live).
    version: 4,
    name:    'session-ended-at',
    backup:  'pre-session-ended-at',
    up(conn) {
      ensureColumn(conn, 'sessions', 'ended_at', 'INTEGER');
      const sessions = conn.prepare('SELECT id, saved_at FROM sessions ORDER BY id').all<{id: string; saved_at: string}>();
      const lastRowEnd = conn.prepare('SELECT MAX(ended_at) AS e FROM session_maps WHERE session_id = ?');
      const update     = conn.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?');
      let fallbacks = 0;
      for (const s of sessions) {
        let endedAt = Date.parse(s.saved_at);
        if (Number.isNaN(endedAt)) {
          endedAt = lastRowEnd.get<{e: number | null}>(s.id)?.e ?? 0;
          fallbacks++;
          log.warn('database', `Session end migration: session ${s.id}: unparsable saved_at ${JSON.stringify(s.saved_at)}, using ${endedAt}`);
        }
        update.run(endedAt, s.id);
      }
      log.info('database', `Session end migration: ${sessions.length} sessions backfilled (${fallbacks} from fallback)`);
    },
  },
  {
    // A row belongs to an existing session (FK, cascading delete); a session has
    // one primary row per map index (partial unique: overlap rows share their
    // parent's index). A generic rule, not a repair: a violating session is
    // deleted whole, never renumbered. Also stores the inferred attribution
    // era and drops the dead seasonal_stats and wealth_datapoints.session_id.
    version:        5,
    name:           'session-integrity',
    backup:         'pre-session-integrity',
    foreignKeysOff: true,
    up(conn) {
      // 1. Sessions with a duplicated primary (session_id, map_index): deleted with every row.
      //    Before the copy below, which the unique index would refuse.
      const dupSessions = conn.prepare(`
        SELECT id, name FROM sessions WHERE id IN (
          SELECT session_id FROM session_maps WHERE parent_map_index IS NULL
          GROUP BY session_id, map_index HAVING COUNT(*) > 1
        ) ORDER BY id
      `).all<{id: string; name: string}>();
      const deleteRows    = conn.prepare('DELETE FROM session_maps WHERE session_id = ?');
      const deleteSession = conn.prepare('DELETE FROM sessions WHERE id = ?');
      let dupRows = 0;
      for (const s of dupSessions) {
        const {changes} = deleteRows.run(s.id);
        deleteSession.run(s.id);
        dupRows += changes;
        log.info('database', `Session integrity migration: deleted session ${s.id} ${JSON.stringify(s.name)} (duplicated primary map index, ${changes} rows)`);
      }
      log.info('database', `Session integrity migration: ${dupSessions.length} sessions with duplicated primary map indexes deleted (${dupRows} rows)`);

      // 2. Rebuild session_maps with the FK, same columns in the same order, ids kept.
      //    The old AUTOINCREMENT high-water mark is carried over so no id is ever reused.
      const oldSeq = conn.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'session_maps'").get<{seq: number}>()?.seq ?? 0;
      const {n: orphans} = conn.prepare('SELECT COUNT(*) AS n FROM session_maps WHERE session_id NOT IN (SELECT id FROM sessions)')
        .get<{n: number}>()!;
      conn.exec(`
        CREATE TABLE session_maps_new (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          map_index        INTEGER NOT NULL,
          started_at       REAL NOT NULL,
          duration         REAL NOT NULL,
          drops            TEXT NOT NULL DEFAULT '{}',
          spent            TEXT NOT NULL DEFAULT '{}',
          seasonal_type    TEXT,
          parent_map_index INTEGER,
          phase            TEXT,
          ended_at         INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO session_maps_new (id, session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase, ended_at)
          SELECT id, session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase, ended_at
          FROM session_maps WHERE session_id IN (SELECT id FROM sessions);
        DROP TABLE session_maps;
        ALTER TABLE session_maps_new RENAME TO session_maps;
        CREATE INDEX idx_session_maps_session ON session_maps (session_id);
        CREATE UNIQUE INDEX idx_session_maps_primary ON session_maps (session_id, map_index) WHERE parent_map_index IS NULL;
      `);
      const newSeq = conn.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'session_maps'").get<{seq: number}>()?.seq;
      if (newSeq === undefined) {
        if (oldSeq > 0) conn.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('session_maps', ?)").run(oldSeq);
      } else if (oldSeq > newSeq) {
        conn.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'session_maps'").run(oldSeq);
      }
      const {n: kept} = conn.prepare('SELECT COUNT(*) AS n FROM session_maps').get<{n: number}>()!;
      log.info('database', `Session integrity migration: session_maps rebuilt, ${kept} rows kept, ${orphans} orphan rows dropped`);

      // 3. attribution '' (pre-column rows): the former read-time rule — no drops_by_source
      //    keys → legacy, else exclusive. v2 never adds or empties those keys.
      const blanks = conn.prepare("SELECT id, drops_by_source FROM sessions WHERE attribution = '' ORDER BY id")
        .all<{id: string; drops_by_source: string}>();
      const setAttribution = conn.prepare('UPDATE sessions SET attribution = ? WHERE id = ?');
      let legacy = 0, exclusive = 0, unparsable = 0;
      for (const s of blanks) {
        let era: 'legacy' | 'exclusive';
        try {
          era = Object.keys(JSON.parse(s.drops_by_source)).length === 0 ? 'legacy' : 'exclusive';
        } catch {
          era = 'legacy';
          unparsable++;
          log.warn('database', `Session integrity migration: session ${s.id}: unparsable drops_by_source ${JSON.stringify(s.drops_by_source)}, attribution set to legacy`);
        }
        setAttribution.run(era, s.id);
        if (era === 'legacy') legacy++;
        else exclusive++;
      }
      log.info('database', `Session integrity migration: attribution backfilled on ${blanks.length} sessions (${legacy} legacy, ${exclusive} exclusive, ${unparsable} unparsable)`);

      // 4. Never read or written by the app.
      const hadSeasonal = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seasonal_stats'").get() !== undefined;
      conn.exec('DROP TABLE IF EXISTS seasonal_stats');
      if (hadSeasonal) log.info('database', 'Session integrity migration: dropped seasonal_stats');

      // 5. Never read; its ids outlived the sessions they named.
      const wealthCols = conn.prepare('PRAGMA table_info(wealth_datapoints)').all<{name: string}>();
      if (wealthCols.some(c => c.name === 'session_id')) {
        conn.exec('ALTER TABLE wealth_datapoints DROP COLUMN session_id');
        log.info('database', 'Session integrity migration: dropped wealth_datapoints.session_id');
      }
    },
  },
];
