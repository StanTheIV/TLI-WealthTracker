import Database from 'better-sqlite3';
import {app} from 'electron';
import {join} from 'path';
import {log} from './logger';
import type {SeasonalType, SeasonalPhase} from './engine/tracker';
import type {League, LeagueSource} from '@/lib/leagues';
import type {PriceMover, PriceExportRow} from '@/types/electron';
import {
  summarize, shouldSkipDuplicate, extractBackfillPoints, bucket, pickBucketMs,
  type PriceBucket, type BucketObservation,
} from './prices/history';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function initDb(): void {
  const dbPath = join(app.getPath('userData'), 'tli-tracker.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables();
  log.info('database', `Database initialized at ${dbPath}`);
}

function migrateWealth(): void {
  try {
    db.exec("ALTER TABLE wealth_datapoints ADD COLUMN breakdown TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // Column already exists — ignore
  }
}

function createTables(): void {
  db.exec(`
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
  `);
  migrateWealth();
  migrateItems();
  migrateFilters();
  migrateSessionMaps();
  migrateSessionMapsParent();
  migrateSessionMapsPhase();
  migrateSessionsDropsBySource();
  migrateSessionsAttribution();
  migrateSessionsPriceSnapshot();
  log.debug('database', 'Tables created');
}

function migrateFilters(): void {
  try {
    // no-op — placeholder for future migrations
  } catch {
    // ignore
  }
}

function migrateSessionMaps(): void {
  try {
    db.exec("ALTER TABLE session_maps ADD COLUMN seasonal_type TEXT");
  } catch {
    // Column already exists — ignore
  }
}

function migrateSessionMapsParent(): void {
  try {
    db.exec("ALTER TABLE session_maps ADD COLUMN parent_map_index INTEGER");
  } catch {
    // Column already exists — ignore
  }
}

/** Existing sandlord rows keep phase=NULL, which readers must treat as 'hub':
 *  in-map sandlord tracking didn't exist when they were written. */
function migrateSessionMapsPhase(): void {
  try {
    db.exec("ALTER TABLE session_maps ADD COLUMN phase TEXT");
  } catch {
    // Column already exists — ignore
  }
}

function migrateSessionsDropsBySource(): void {
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN drops_by_source TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // Column already exists — ignore
  }
}

/** Existing rows keep attribution='' and are classified at read time from
 *  drops_by_source (see rowToSession) — backfilling would be a lie, since the
 *  engine era that wrote them can't be recovered from the row itself. */
function migrateSessionsAttribution(): void {
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN attribution TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore
  }
}

/** Existing rows keep price_snapshot='{}', which readers treat as "no snapshot"
 *  and fall back to live prices for. Backfilling from today's prices would be a
 *  lie — it would claim the session was worth at save time what it is worth now,
 *  which is the exact drift the snapshot exists to expose. */
function migrateSessionsPriceSnapshot(): void {
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN price_snapshot TEXT NOT NULL DEFAULT '{}'");
  } catch {
    // Column already exists — ignore
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function settingsGetAll(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {key: string; value: string}[];
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export function settingsGet(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as {value: string} | undefined;
  return row?.value;
}

export function settingsSet(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// ---------------------------------------------------------------------------
// Items (price table)
// ---------------------------------------------------------------------------

export interface DbItem {
  id:        string;
  name:      string;
  type:      string;
  price:     number;
  priceDate: number;
  /** Local-only flag: when true, automated price scrapes from the worker skip
   *  this item. Manual edits in the UI still go through. Excluded from
   *  full_table.json import/export by design — it's per-installation. */
  locked?:   boolean;
}

function migrateItems(): void {
  try {
    db.exec("ALTER TABLE items ADD COLUMN price_date REAL NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore
  }
  try {
    db.exec("ALTER TABLE items ADD COLUMN locked INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — ignore
  }

  // Normalize legacy empty-string types to 'other' so the UI never renders
  // a blank "types." i18n key. Safe to run repeatedly.
  const result = db.prepare("UPDATE items SET type = 'other' WHERE type = ''").run() as {changes: number};
  if (result.changes > 0) {
    log.info('database', `Migrated ${result.changes} items with empty type to 'other'`);
  }
}

export function itemsCount(): number {
  return (db.prepare('SELECT COUNT(*) as count FROM items').get() as {count: number}).count;
}

export function itemsGetAll(): DbItem[] {
  const rows = db.prepare('SELECT id, name, type, price, price_date, locked FROM items').all() as {id: string; name: string; type: string; price: number; price_date: number; locked: number}[];
  return rows.map(r => ({id: r.id, name: r.name, type: r.type, price: r.price, priceDate: r.price_date, locked: r.locked === 1}));
}

/** Upsert an item. Note: the `locked` flag is intentionally NOT touched here —
 *  it's a local-only setting and full-table import must not overwrite it.
 *  New rows default to locked=0 via the column default. */
export function itemsUpsert(item: DbItem): void {
  db.prepare(`
    INSERT INTO items (id, name, type, price, price_date)
    VALUES (@id, @name, @type, @price, @priceDate)
    ON CONFLICT(id) DO UPDATE SET
      name       = excluded.name,
      type       = excluded.type,
      price      = excluded.price,
      price_date = excluded.price_date
  `).run(item);
}

/** Insert a placeholder row only if the id does not already exist. Never overwrites. */
export function itemsInsertIfMissing(id: string): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO items (id, name, type, price, price_date) VALUES (?, '', 'other', 0, 0)`
  ).run(id) as {changes: number};
  return result.changes > 0;
}

/** Returns the ids actually inserted (rows skipped by INSERT OR IGNORE are omitted). */
export function itemsImportBatch(items: DbItem[]): string[] {
  const stmt = db.prepare('INSERT OR IGNORE INTO items (id, name, type, price, price_date) VALUES (@id, @name, @type, @price, @priceDate)');
  const run  = db.transaction((rows: DbItem[]) => {
    const inserted: string[] = [];
    for (const row of rows) {
      const result = stmt.run(row) as {changes: number};
      if (result.changes > 0) inserted.push(row.id);
    }
    return inserted;
  });
  const inserted = run(items) as string[];
  log.info('database', `Item import: ${inserted.length} of ${items.length} items inserted`);
  return inserted;
}

export function itemsSetName(id: string, name: string): void {
  db.prepare('UPDATE items SET name = ? WHERE id = ?').run(name, id);
}

export function itemsSetType(id: string, type: string): void {
  db.prepare('UPDATE items SET type = ? WHERE id = ?').run(type, id);
}

export function itemsSetPrice(id: string, price: number, at: number = Date.now()): void {
  db.prepare('UPDATE items SET price = ?, price_date = ? WHERE id = ?').run(price, at, id);
  log.debug('price', `Price written: item=${id}, price=${price}`);
}

/** Read just the `locked` flag — used by the worker price-update path to skip
 *  scraped updates for locked items without fetching the full row. */
export function itemsGetLocked(id: string): boolean {
  const row = db.prepare('SELECT locked FROM items WHERE id = ?').get(id) as {locked: number} | undefined;
  return row?.locked === 1;
}

export function itemsSetLocked(id: string, locked: boolean): void {
  db.prepare('UPDATE items SET locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
}

// ---------------------------------------------------------------------------
// API Lookups (rate-limiting for tlidb name lookups)
// ---------------------------------------------------------------------------

function todayDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export function getLookupCountToday(): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM api_lookups WHERE date = ?').get(todayDate()) as {cnt: number};
  return row.cnt;
}

export function recordLookup(itemId: string): void {
  db.prepare('INSERT INTO api_lookups (date, item_id, timestamp) VALUES (?, ?, ?)').run(todayDate(), itemId, Date.now());
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface DbSession {
  id:            string;
  name:          string;
  savedAt:       string;
  totalTime:     number;
  mapTime:       number;
  mapCount:      number;
  drops:         Record<string, number>;
  /** Per-source attribution for the source-breakdown pie. Each itemId qty
   *  appears under exactly one source (the owner tracker at write time), so
   *  slices sum to exactly session FE regardless of attribution era. Empty for
   *  legacy sessions saved before this column existed — pie falls back to
   *  per-map-row aggregation in that case. */
  dropsBySource: Record<string, Record<string, number>>;
  /** Which attribution era wrote this session's per-map rows. Decides whether
   *  a parent map row already contains its overlap seasonals' drops — see
   *  SessionAttribution. Never '' after rowToSession normalises it. */
  attribution:   SessionAttribution;
  /** Item prices captured at save time, keyed by itemId. Lets the detail page
   *  show what the haul was worth *then* alongside what it is worth now.
   *  Empty for sessions saved before this column existed — readers must treat
   *  `{}` as "no snapshot" and fall back to live prices rather than 0. */
  priceSnapshot: Record<string, number>;
}

/**
 * Attribution era of a saved session. Governs how `session_maps` rows combine:
 *   legacy       — old fan-out engine: parent map rows CONTAIN overlap drops.
 *   exclusive    — single-owner: parent map rows EXCLUDE overlap drops, so
 *                  overlap income must be folded back into the parent.
 *   drop-through — current: parent map rows CONTAIN overlap drops again, and
 *                  overlap rows are a pure per-seasonal breakdown of them.
 * Legacy and drop-through share the same sum-across-rows maths (primary rows
 * only); exclusive is the era needing the fold.
 */
export type SessionAttribution = 'legacy' | 'exclusive' | 'drop-through';

type SessionRow = {
  id:              string;
  name:            string;
  saved_at:        string;
  total_time:      number;
  map_time:        number;
  map_count:       number;
  drops:           string;
  drops_by_source: string;
  attribution:     string;
  price_snapshot:  string;
};

function rowToSession(r: SessionRow): DbSession {
  const dropsBySource = JSON.parse(r.drops_by_source ?? '{}');
  // Rows written before the attribution column: dropsBySource was introduced
  // together with exclusive attribution, so its presence dates the row.
  const attribution = (r.attribution || null) as SessionAttribution | null
    ?? (Object.keys(dropsBySource).length === 0 ? 'legacy' : 'exclusive');
  return {
    id:            r.id,
    name:          r.name,
    savedAt:       r.saved_at,
    totalTime:     r.total_time,
    mapTime:       r.map_time,
    mapCount:      r.map_count,
    drops:         JSON.parse(r.drops),
    dropsBySource,
    attribution,
    priceSnapshot: JSON.parse(r.price_snapshot ?? '{}'),
  };
}

export function sessionsGetAll(): DbSession[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY saved_at DESC').all() as SessionRow[];
  return rows.map(rowToSession);
}

export function sessionsInsert(session: DbSession): void {
  db.prepare(`
    INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops, drops_by_source, attribution, price_snapshot)
    VALUES (@id, @name, @savedAt, @totalTime, @mapTime, @mapCount, @drops, @dropsBySource, @attribution, @priceSnapshot)
  `).run({
    ...session,
    drops:         JSON.stringify(session.drops),
    dropsBySource: JSON.stringify(session.dropsBySource),
    priceSnapshot: JSON.stringify(session.priceSnapshot ?? {}),
  });
}

export function sessionsUpdate(session: DbSession): void {
  db.prepare(`
    UPDATE sessions
    SET name = @name, saved_at = @savedAt, total_time = @totalTime,
        map_time = @mapTime, map_count = @mapCount, drops = @drops,
        drops_by_source = @dropsBySource, attribution = @attribution,
        price_snapshot = @priceSnapshot
    WHERE id = @id
  `).run({
    ...session,
    drops:         JSON.stringify(session.drops),
    dropsBySource: JSON.stringify(session.dropsBySource),
    priceSnapshot: JSON.stringify(session.priceSnapshot ?? {}),
  });
}

export function sessionsDelete(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  // Cascade: per-map rows have no FK constraint; clean them up explicitly so
  // deleting a session doesn't leave orphans behind.
  sessionMapsDeleteForSession(id);
}

export function sessionsRename(id: string, name: string): void {
  db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
}

export function sessionsGetOne(id: string): DbSession | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) return null;
  return rowToSession(row);
}

// ---------------------------------------------------------------------------
// Session maps — per-map breakdown rows attached to a session
// ---------------------------------------------------------------------------

export interface DbSessionMap {
  sessionId:    string;
  mapIndex:     number;
  startedAt:    number;        // ms epoch
  duration:     number;        // ms
  drops:        Record<string, number>;
  spent:        Record<string, number>;
  /** Non-null when this row represents a standalone seasonal run (e.g. Sandlord)
   *  rather than a regular map. Null for plain map rows. */
  seasonalType: SeasonalType | null;
  /** Non-null only for "overlap" seasonal rows that ran inside a regular map —
   *  points at the `mapIndex` of the parent map row. Null for primary rows
   *  (regular maps and standalone seasonals). Whether those drops are ALSO in
   *  the parent row depends on the session's `attribution` era, so aggregations
   *  that sum across rows must branch on it — see SessionAttribution. */
  parentMapIndex: number | null;
  /** Sandlord phase for seasonal_type='sandlord' rows: 'map' (in-map coin tile)
   *  or 'hub' (own-area hub bubble). Null for other rows AND for sandlord rows
   *  written before this column existed — readers must treat null as 'hub',
   *  since in-map tracking didn't exist back then. */
  phase: SeasonalPhase | null;
}

export function sessionMapsInsert(rows: DbSessionMap[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
    VALUES (@sessionId, @mapIndex, @startedAt, @duration, @drops, @spent, @seasonalType, @parentMapIndex, @phase)
  `);
  const tx = db.transaction((rs: DbSessionMap[]) => {
    for (const r of rs) {
      stmt.run({
        ...r,
        drops:          JSON.stringify(r.drops),
        spent:          JSON.stringify(r.spent),
        seasonalType:   r.seasonalType,
        parentMapIndex: r.parentMapIndex,
        phase:          r.phase,
      });
    }
  });
  tx(rows);
}

export function sessionMapsGetForSession(sessionId: string): DbSessionMap[] {
  const rows = db.prepare(
    'SELECT session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase FROM session_maps WHERE session_id = ? ORDER BY id ASC'
  ).all(sessionId) as {session_id: string; map_index: number; started_at: number; duration: number; drops: string; spent: string; seasonal_type: string | null; parent_map_index: number | null; phase: string | null}[];
  return rows.map(r => ({
    sessionId:      r.session_id,
    mapIndex:       r.map_index,
    startedAt:      r.started_at,
    duration:       r.duration,
    drops:          JSON.parse(r.drops),
    spent:          JSON.parse(r.spent),
    seasonalType:   r.seasonal_type as SeasonalType | null,
    parentMapIndex: r.parent_map_index,
    phase:          r.phase as SeasonalPhase | null,
  }));
}

export function sessionMapsDeleteForSession(sessionId: string): void {
  db.prepare('DELETE FROM session_maps WHERE session_id = ?').run(sessionId);
}

// ---------------------------------------------------------------------------
// Seasonal stats
// ---------------------------------------------------------------------------

export interface DbSeasonalStat {
  zoneType:    string;
  zoneCount:   number;
  totalTime:   number;
  totalIncome: number;
  dropList:    Record<string, number>;
}

export function seasonalStatsGetAll(): DbSeasonalStat[] {
  const rows = db.prepare('SELECT * FROM seasonal_stats').all() as {zone_type: string; zone_count: number; total_time: number; total_income: number; drop_list: string}[];
  return rows.map(r => ({zoneType: r.zone_type, zoneCount: r.zone_count, totalTime: r.total_time, totalIncome: r.total_income, dropList: JSON.parse(r.drop_list)}));
}

export function seasonalStatsUpsert(stat: DbSeasonalStat): void {
  db.prepare(`
    INSERT INTO seasonal_stats (zone_type, zone_count, total_time, total_income, drop_list)
    VALUES (@zoneType, @zoneCount, @totalTime, @totalIncome, @dropList)
    ON CONFLICT(zone_type) DO UPDATE SET
      zone_count   = excluded.zone_count,
      total_time   = excluded.total_time,
      total_income = excluded.total_income,
      drop_list    = excluded.drop_list
  `).run({...stat, dropList: JSON.stringify(stat.dropList)});
}

// ---------------------------------------------------------------------------
// Wealth datapoints
// ---------------------------------------------------------------------------

export interface DbWealthDatapoint {
  /** Row id — present on every read, absent when inserting. */
  id?:       number;
  timestamp: number;
  value:     number;
  sessionId: string | null;
  breakdown: string; // JSON: Record<itemId, {qty, price, total}>
}

type WealthRow = {id: number; timestamp: number; value: number; session_id: string | null; breakdown: string};

function rowToDatapoint(r: WealthRow): DbWealthDatapoint {
  return {id: r.id, timestamp: r.timestamp, value: r.value, sessionId: r.session_id, breakdown: r.breakdown};
}

export function wealthInsert(point: DbWealthDatapoint): void {
  db.prepare('INSERT INTO wealth_datapoints (timestamp, value, session_id, breakdown) VALUES (@timestamp, @value, @sessionId, @breakdown)')
    .run({timestamp: point.timestamp, value: point.value, sessionId: point.sessionId, breakdown: point.breakdown});
}

export function wealthGetRange(from: number, to: number): DbWealthDatapoint[] {
  const rows = db.prepare('SELECT id, timestamp, value, session_id, breakdown FROM wealth_datapoints WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp')
    .all(from, to) as WealthRow[];
  return rows.map(rowToDatapoint);
}

export function wealthGetLatest(limit: number): DbWealthDatapoint[] {
  const rows = db.prepare('SELECT id, timestamp, value, session_id, breakdown FROM wealth_datapoints ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as WealthRow[];
  return rows.map(rowToDatapoint).reverse();
}

/** Remove one reading — e.g. a snapshot taken while the inventory was miscounted. */
export function wealthDelete(id: number): void {
  db.prepare('DELETE FROM wealth_datapoints WHERE id = ?').run(id);
}

export function wealthClear(): void {
  // The wealth reset button is a "clear all historical farming data" action.
  // Wealth datapoints, saved sessions, and per-map breakdowns all describe
  // the same farming history from different angles, so they go together.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM wealth_datapoints').run();
    db.prepare('DELETE FROM session_maps').run();
    db.prepare('DELETE FROM sessions').run();
  });
  tx();
}

// ---------------------------------------------------------------------------
// Item filters
// ---------------------------------------------------------------------------

export interface DbItemFilter {
  id:      string;
  name:    string;
  enabled: boolean;
  rules:   string; // JSON array of FilterRule
}

export function filtersGetAll(): DbItemFilter[] {
  const rows = db.prepare('SELECT id, name, enabled, rules FROM item_filters ORDER BY rowid').all() as {id: string; name: string; enabled: number; rules: string}[];
  return rows.map(r => ({id: r.id, name: r.name, enabled: r.enabled === 1, rules: r.rules}));
}

export function filtersInsert(filter: DbItemFilter): void {
  db.prepare('INSERT INTO item_filters (id, name, enabled, rules) VALUES (@id, @name, @enabled, @rules)')
    .run({...filter, enabled: filter.enabled ? 1 : 0});
}

export function filtersUpdate(filter: DbItemFilter): void {
  db.prepare('UPDATE item_filters SET name = @name, enabled = @enabled, rules = @rules WHERE id = @id')
    .run({...filter, enabled: filter.enabled ? 1 : 0});
}

export function filtersDelete(id: string): void {
  db.prepare('DELETE FROM item_filters WHERE id = ?').run(id);
}

export function filtersSetEnabled(id: string, enabled: boolean): void {
  // Use a transaction: disable all, then enable the target (or just disable all if enabled=false)
  const toggle = db.transaction(() => {
    db.prepare('UPDATE item_filters SET enabled = 0').run();
    if (enabled) {
      db.prepare('UPDATE item_filters SET enabled = 1 WHERE id = ?').run(id);
    }
  });
  toggle();
}

// ---------------------------------------------------------------------------
// Price history (append-only observations + AH order book)
// ---------------------------------------------------------------------------

/**
 * Record a price observation (and optionally update items.price) atomically.
 *
 * - Scrapes repeating the previous observation (same median, same n, <=2 min) are NOT
 *   inserted into history, but still refresh items.price/price_date when `updateItem`
 *   (the market re-confirmed the price, so the "last seen" date moves).
 * - Manual edits are never de-duplicated; they carry no summary columns/listings.
 * - One `now` is used for the observation and price_date, and returned as `priceDate`
 *   (null when the item row wasn't updated).
 */
export function priceRecord(
  itemId: string,
  source: 'scrape' | 'manual',
  median: number,
  listings: number[] | undefined,
  opts: {updateItem: boolean},
): {recorded: boolean; priceDate: number | null} {
  const tx = db.transaction((): {recorded: boolean; priceDate: number | null} => {
    const now = Date.now();
    const summary = source === 'scrape' && listings && listings.length > 0 ? summarize(listings) : null;
    let recorded = false;

    const last = db.prepare(
      'SELECT price, n, timestamp FROM price_observations WHERE item_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1',
    ).get(itemId) as {price: number; n: number | null; timestamp: number} | undefined;

    const dup = source === 'scrape' && shouldSkipDuplicate(last, {timestamp: now, price: median, n: summary?.n ?? null});
    if (!dup) {
      const res = db.prepare(
        `INSERT INTO price_observations (item_id, timestamp, source, price, n, p10, p25, p75, p90, min_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        itemId, now, source, median,
        summary?.n ?? null, summary?.p10 ?? null, summary?.p25 ?? null,
        summary?.p75 ?? null, summary?.p90 ?? null, summary?.min ?? null,
      );
      recorded = true;
      if (summary && listings) {
        const obsId = Number(res.lastInsertRowid);
        const ins = db.prepare('INSERT INTO price_listings (observation_id, rank, price) VALUES (?, ?, ?)');
        const sorted = listings.filter(Number.isFinite).sort((a, b) => a - b);
        for (let i = 0; i < sorted.length; i++) ins.run(obsId, i, sorted[i]);
      }
    }

    if (opts.updateItem) {
      itemsSetPrice(itemId, median, now);
      return {recorded, priceDate: now};
    }
    return {recorded, priceDate: null};
  });
  return tx();
}

/**
 * One-time history backfill from wealth_datapoints.breakdown and sessions.price_snapshot
 * (compressed to change-points), plus each priced item's current items.price/price_date
 * when that is a newer AND different price than the item's last backfill point.
 * Guarded by the `price_backfill_done` setting, which is set in the same transaction.
 */
export function priceBackfillOnce(): {inserted: number; skipped: boolean} {
  if (settingsGet('price_backfill_done')) return {inserted: 0, skipped: true};

  const tx = db.transaction(() => {
    const wealth = db.prepare('SELECT timestamp, breakdown FROM wealth_datapoints ORDER BY timestamp')
      .all() as {timestamp: number; breakdown: string}[];
    const sessions = db.prepare('SELECT saved_at, price_snapshot FROM sessions')
      .all() as {saved_at: string; price_snapshot: string}[];
    const points = extractBackfillPoints(wealth, sessions);

    // Points are sorted by (item, time), so the last one seen per item is its latest.
    const lastByItem = new Map<string, {timestamp: number; price: number}>();
    for (const p of points) lastByItem.set(p.itemId, p);

    let currentAdded = 0;
    const items = db.prepare('SELECT id, price, price_date FROM items WHERE price > 0 AND price_date > 0')
      .all() as {id: string; price: number; price_date: number}[];
    for (const it of items) {
      const last = lastByItem.get(it.id);
      if (last && (it.price_date <= last.timestamp || it.price === last.price)) continue;
      points.push({itemId: it.id, timestamp: it.price_date, price: it.price});
      currentAdded++;
    }

    const ins = db.prepare(
      "INSERT INTO price_observations (item_id, timestamp, source, price) VALUES (?, ?, 'backfill', ?)",
    );
    for (const p of points) ins.run(p.itemId, p.timestamp, p.price);
    settingsSet('price_backfill_done', '1');
    log.info('price', `Price backfill: ${points.length} observations (${wealth.length} wealth rows, ${sessions.length} sessions, ${currentAdded} current-price points)`);
    return points.length;
  });
  return {inserted: tx(), skipped: false};
}

/** Bucketed history for one item over [from, to). */
export function pricesHistory(itemId: string, from: number, to: number): PriceBucket[] {
  const obs = db.prepare(
    'SELECT id, timestamp, price, source, n FROM price_observations WHERE item_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp, id',
  ).all(itemId, from, to) as BucketObservation[];
  if (obs.length === 0) return [];

  const listingRows = db.prepare(
    `SELECT observation_id, price FROM price_listings
     WHERE observation_id IN (SELECT id FROM price_observations WHERE item_id = ? AND timestamp >= ? AND timestamp < ?)
     ORDER BY observation_id, rank`,
  ).all(itemId, from, to) as {observation_id: number; price: number}[];
  const listingsByObs = new Map<number, number[]>();
  for (const r of listingRows) {
    const arr = listingsByObs.get(r.observation_id);
    if (arr) arr.push(r.price);
    else listingsByObs.set(r.observation_id, [r.price]);
  }

  // Span of the requested window, clipped to where data starts ('all' begins at 0).
  const span = to - Math.max(from, obs[0].timestamp);
  return bucket(obs, listingsByObs, pickBucketMs(span));
}

/** Per-item first/last/min/max median and % change over [from, to). */
export function pricesMovers(from: number, to: number): PriceMover[] {
  const rows = db.prepare(
    `WITH r AS (
       SELECT item_id, price,
              ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY timestamp ASC,  id ASC)  AS rn_first,
              ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY timestamp DESC, id DESC) AS rn_last
       FROM price_observations
       WHERE timestamp >= ? AND timestamp < ?
     )
     SELECT r.item_id AS itemId, COALESCE(i.name, '') AS name, COALESCE(i.type, 'other') AS type,
            MAX(CASE WHEN r.rn_first = 1 THEN r.price END) AS first,
            MAX(CASE WHEN r.rn_last  = 1 THEN r.price END) AS last,
            MIN(r.price) AS min, MAX(r.price) AS max, COUNT(*) AS count
     FROM r LEFT JOIN items i ON i.id = r.item_id
     GROUP BY r.item_id`,
  ).all(from, to) as Omit<PriceMover, 'pctChange'>[];
  return rows.map(r => ({...r, pctChange: r.first > 0 ? (r.last - r.first) / r.first : null}));
}

/** Raw observations over [from, to) for CSV export, oldest first. */
export function pricesExport(from: number, to: number): PriceExportRow[] {
  return db.prepare(
    `SELECT o.timestamp AS timestamp, o.item_id AS itemId, COALESCE(i.name, '') AS name, o.source AS source,
            o.price AS price, o.n AS n, o.p10 AS p10, o.p25 AS p25, o.p75 AS p75, o.p90 AS p90, o.min_price AS min
     FROM price_observations o LEFT JOIN items i ON i.id = o.item_id
     WHERE o.timestamp >= ? AND o.timestamp < ?
     ORDER BY o.timestamp, o.id`,
  ).all(from, to) as PriceExportRow[];
}

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

export function leaguesGetAll(): League[] {
  const rows = db.prepare('SELECT id, name, starts_at, source FROM leagues ORDER BY starts_at')
    .all() as {id: string; name: string; starts_at: number; source: string}[];
  return rows.map(r => ({id: r.id, name: r.name, startsAt: r.starts_at, source: r.source as LeagueSource}));
}

export function leaguesApply(change: {upserts: League[]; deletes: string[]}): void {
  const up  = db.prepare(
    `INSERT INTO leagues (id, name, starts_at, source) VALUES (@id, @name, @startsAt, @source)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, starts_at = excluded.starts_at, source = excluded.source`,
  );
  const del = db.prepare('DELETE FROM leagues WHERE id = ?');
  db.transaction(() => {
    for (const l of change.upserts) up.run(l);
    for (const id of change.deletes) del.run(id);
  })();
}

export function leaguesInsertUser(name: string, startsAt: number): League {
  const league: League = {id: `user-${startsAt}`, name, startsAt, source: 'user'};
  db.prepare('INSERT INTO leagues (id, name, starts_at, source) VALUES (@id, @name, @startsAt, @source)').run(league);
  return league;
}

/** Edit a user league's start. Official (bundled/remote) rows are rejected. Returns whether a row changed. */
export function leaguesSetStart(id: string, startsAt: number): boolean {
  const res = db.prepare("UPDATE leagues SET starts_at = ? WHERE id = ? AND source = 'user'").run(startsAt, id);
  return res.changes > 0;
}
