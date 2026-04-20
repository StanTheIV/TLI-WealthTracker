import Database from 'better-sqlite3';
import {app} from 'electron';
import {join} from 'path';
import {log} from './logger';

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
      price_date REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      saved_at   TEXT NOT NULL,
      total_time REAL NOT NULL DEFAULT 0,
      map_time   REAL NOT NULL DEFAULT 0,
      map_count  INTEGER NOT NULL DEFAULT 0,
      drops      TEXT NOT NULL DEFAULT '{}'
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
  `);
  migrateWealth();
  migrateItems();
  migrateFilters();
  log.debug('database', 'Tables created');
}

function migrateFilters(): void {
  try {
    // no-op — placeholder for future migrations
  } catch {
    // ignore
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
}

function migrateItems(): void {
  try {
    db.exec("ALTER TABLE items ADD COLUMN price_date REAL NOT NULL DEFAULT 0");
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
  const rows = db.prepare('SELECT id, name, type, price, price_date FROM items').all() as {id: string; name: string; type: string; price: number; price_date: number}[];
  return rows.map(r => ({id: r.id, name: r.name, type: r.type, price: r.price, priceDate: r.price_date}));
}

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

export function itemsImportBatch(items: DbItem[]): number {
  const stmt = db.prepare('INSERT OR IGNORE INTO items (id, name, type, price, price_date) VALUES (@id, @name, @type, @price, @priceDate)');
  const run  = db.transaction((rows: DbItem[]) => {
    let inserted = 0;
    for (const row of rows) {
      const result = stmt.run(row) as {changes: number};
      inserted += result.changes;
    }
    return inserted;
  });
  const inserted = run(items) as number;
  log.info('database', `Item import: ${inserted} of ${items.length} items inserted`);
  return inserted;
}

export function itemsSetName(id: string, name: string): void {
  db.prepare('UPDATE items SET name = ? WHERE id = ?').run(name, id);
}

export function itemsSetType(id: string, type: string): void {
  db.prepare('UPDATE items SET type = ? WHERE id = ?').run(type, id);
}

export function itemsSetPrice(id: string, price: number): void {
  db.prepare('UPDATE items SET price = ?, price_date = ? WHERE id = ?').run(price, Date.now(), id);
  log.debug('price', `Price written: item=${id}, price=${price}`);
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
  id:        string;
  name:      string;
  savedAt:   string;
  totalTime: number;
  mapTime:   number;
  mapCount:  number;
  drops:     Record<string, number>;
}

export function sessionsGetAll(): DbSession[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY saved_at DESC').all() as {id: string; name: string; saved_at: string; total_time: number; map_time: number; map_count: number; drops: string}[];
  return rows.map(r => ({id: r.id, name: r.name, savedAt: r.saved_at, totalTime: r.total_time, mapTime: r.map_time, mapCount: r.map_count, drops: JSON.parse(r.drops)}));
}

export function sessionsInsert(session: DbSession): void {
  db.prepare(`
    INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops)
    VALUES (@id, @name, @savedAt, @totalTime, @mapTime, @mapCount, @drops)
  `).run({...session, drops: JSON.stringify(session.drops)});
}

export function sessionsUpdate(session: DbSession): void {
  db.prepare(`
    UPDATE sessions
    SET name = @name, saved_at = @savedAt, total_time = @totalTime,
        map_time = @mapTime, map_count = @mapCount, drops = @drops
    WHERE id = @id
  `).run({...session, drops: JSON.stringify(session.drops)});
}

export function sessionsDelete(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function sessionsRename(id: string, name: string): void {
  db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
}

export function sessionsGetOne(id: string): DbSession | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as {id: string; name: string; saved_at: string; total_time: number; map_time: number; map_count: number; drops: string} | undefined;
  if (!row) return null;
  return {id: row.id, name: row.name, savedAt: row.saved_at, totalTime: row.total_time, mapTime: row.map_time, mapCount: row.map_count, drops: JSON.parse(row.drops)};
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
  timestamp: number;
  value:     number;
  sessionId: string | null;
  breakdown: string; // JSON: Record<itemId, {qty, price, total}>
}

function rowToDatapoint(r: {timestamp: number; value: number; session_id: string | null; breakdown: string}): DbWealthDatapoint {
  return {timestamp: r.timestamp, value: r.value, sessionId: r.session_id, breakdown: r.breakdown};
}

export function wealthInsert(point: DbWealthDatapoint): void {
  db.prepare('INSERT INTO wealth_datapoints (timestamp, value, session_id, breakdown) VALUES (@timestamp, @value, @sessionId, @breakdown)')
    .run(point);
}

export function wealthGetRange(from: number, to: number): DbWealthDatapoint[] {
  const rows = db.prepare('SELECT timestamp, value, session_id, breakdown FROM wealth_datapoints WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp')
    .all(from, to) as {timestamp: number; value: number; session_id: string | null; breakdown: string}[];
  return rows.map(rowToDatapoint);
}

export function wealthGetLatest(limit: number): DbWealthDatapoint[] {
  const rows = db.prepare('SELECT timestamp, value, session_id, breakdown FROM wealth_datapoints ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as {timestamp: number; value: number; session_id: string | null; breakdown: string}[];
  return rows.map(rowToDatapoint).reverse();
}

export function wealthClear(): void {
  db.prepare('DELETE FROM wealth_datapoints').run();
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
