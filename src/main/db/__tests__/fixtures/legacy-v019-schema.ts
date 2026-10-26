/** Verbatim from `git show cbc9f21:src/main/db.ts` (v0.19.0) createTables() - the pre-versioning schema. */
export const LEGACY_CREATE_SQL = `
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

/** The v0.19 migrate* ALTERs, each wrapped in try/catch ignoring "already exists". */
export const LEGACY_ALTERS = [
  "ALTER TABLE wealth_datapoints ADD COLUMN breakdown TEXT NOT NULL DEFAULT '{}'",
  'ALTER TABLE items ADD COLUMN price_date REAL NOT NULL DEFAULT 0',
  'ALTER TABLE items ADD COLUMN locked INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_maps ADD COLUMN seasonal_type TEXT',
  'ALTER TABLE session_maps ADD COLUMN parent_map_index INTEGER',
  'ALTER TABLE session_maps ADD COLUMN phase TEXT',
  "ALTER TABLE sessions ADD COLUMN drops_by_source TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE sessions ADD COLUMN attribution TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE sessions ADD COLUMN price_snapshot TEXT NOT NULL DEFAULT '{}'",
];
