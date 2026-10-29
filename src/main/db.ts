import {log} from './logger';
import {MIGRATIONS, runMigrations, type MigrateOptions, type MigrationResult} from './db/migrations';
import type {SqlConn} from './db/sql-conn';
import type {League, LeagueSource} from '@/lib/leagues';
import type {
  DbItem, DbWealthDatapoint, StoredWealthDatapoint,
  PriceBucket, PriceExportRow, PriceMover,
} from '@/shared/contracts/db';
import {describeErrorBrief} from '@/shared/describe-error';
import {decodeFilterRules, type FilterRule, type ItemFilter} from '@/shared/item-filter';
import {
  summarize, shouldSkipDuplicate, extractBackfillPoints, bucket, pickBucketMs,
  type BucketObservation,
} from './prices/history';

let db: SqlConn;

export function getDb(): SqlConn {
  if (!db) throw new Error('Database not initialized');
  return db;
}

/** Adopt an open connection (WAL + foreign keys). The schema may still be old:
 *  main.ts reloads the logger config here, before migrateDb(). */
export function adoptDb(conn: SqlConn): void {
  db = conn;
  db.setPragma('journal_mode', 'WAL');
  db.setPragma('foreign_keys', 'ON');
}

/**
 * Bring the adopted connection's schema up to date, then the start-up data fixes.
 * Returns the migration result so the caller can warn about a newer-than-app schema.
 */
export function migrateDb(opts: MigrateOptions): MigrationResult {
  const result = runMigrations(getDb(), MIGRATIONS, opts);
  normalizeItemTypes();
  return result;
}

/** adoptDb + migrateDb in one call — tests and tools that need no logger in between. */
export function initDb(conn: SqlConn, opts: MigrateOptions): MigrationResult {
  adoptDb(conn);
  return migrateDb(opts);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Throws before adoptDb() (the logger's config reader relies on it: defaults then). */
export function settingsGetAll(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {key: string; value: string}[];
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

/** Normalize legacy empty-string types to 'other' so the UI never renders
 *  a blank "types." i18n key. Runs every start: insert paths can still write ''. */
function normalizeItemTypes(): void {
  const result = db.prepare("UPDATE items SET type = 'other' WHERE type = ''").run();
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

/** Insert a placeholder row only if the id does not already exist. Never overwrites. */
export function itemsInsertIfMissing(id: string): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO items (id, name, type, price, price_date) VALUES (?, '', 'other', 0, 0)`
  ).run(id);
  return result.changes > 0;
}

/** Returns the ids actually inserted (rows skipped by INSERT OR IGNORE are omitted). */
export function itemsImportBatch(items: DbItem[]): string[] {
  const stmt = db.prepare('INSERT OR IGNORE INTO items (id, name, type, price, price_date) VALUES (@id, @name, @type, @price, @priceDate)');
  const inserted = db.transaction(() => {
    const ids: string[] = [];
    for (const row of items) {
      if (stmt.run(row).changes > 0) ids.push(row.id);
    }
    return ids;
  });
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
// Wealth datapoints
// ---------------------------------------------------------------------------

type WealthRow = {id: number; timestamp: number; value: number; breakdown: string};

/** A stored reading without its breakdown. */
export type WealthHead = Omit<StoredWealthDatapoint, 'breakdown'>;

function rowToDatapoint(r: WealthRow): StoredWealthDatapoint {
  return {id: r.id, timestamp: r.timestamp, value: r.value, breakdown: r.breakdown};
}

/** Returns the new row's id (AUTOINCREMENT: never reused, not even after a clear). */
export function wealthInsert(point: DbWealthDatapoint): number {
  return db.prepare('INSERT INTO wealth_datapoints (timestamp, value, breakdown) VALUES (@timestamp, @value, @breakdown)')
    .run({timestamp: point.timestamp, value: point.value, breakdown: point.breakdown}).lastInsertRowid;
}

export function wealthGetRange(from: number, to: number): StoredWealthDatapoint[] {
  const rows = db.prepare('SELECT id, timestamp, value, breakdown FROM wealth_datapoints WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp')
    .all(from, to) as WealthRow[];
  return rows.map(rowToDatapoint);
}

/** `wealthGetRange` without the breakdown column (KBs per row). */
export function wealthGetRangeHeads(from: number, to: number): WealthHead[] {
  const rows = db.prepare('SELECT id, timestamp, value FROM wealth_datapoints WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp, id')
    .all(from, to) as Omit<WealthRow, 'breakdown'>[];
  return rows.map(r => ({id: r.id, timestamp: r.timestamp, value: r.value}));
}

export function wealthGetLatest(limit: number): StoredWealthDatapoint[] {
  const rows = db.prepare('SELECT id, timestamp, value, breakdown FROM wealth_datapoints ORDER BY timestamp DESC LIMIT ?')
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
  // the same farming history from different angles, so they go together
  // (per-map rows by cascade from their session).
  db.transaction(() => {
    db.prepare('DELETE FROM wealth_datapoints').run();
    db.prepare('DELETE FROM sessions').run();
  });
}

// ---------------------------------------------------------------------------
// Item filters
// ---------------------------------------------------------------------------

// The one filter JSON site; rules cross every boundary typed. A stored row that
// fails to decode is external corruption: reading it throws, naming the filter
// (no silent fallback). A malformed write is rejected before anything is stored.

export function filtersGetAll(): ItemFilter[] {
  const rows = db.prepare('SELECT id, name, enabled, rules FROM item_filters ORDER BY rowid').all() as {id: string; name: string; enabled: number; rules: string}[];
  return rows.map(r => ({id: r.id, name: r.name, enabled: r.enabled === 1, rules: decodeStoredRules(r.id, r.rules)}));
}

/** An enabled filter disables every other row (at most one enabled filter). */
export function filtersInsert(filter: ItemFilter): void {
  const rules = encodeRules(filter.rules);
  db.transaction(() => {
    db.prepare('INSERT INTO item_filters (id, name, enabled, rules) VALUES (@id, @name, @enabled, @rules)')
      .run({id: filter.id, name: filter.name, enabled: filter.enabled ? 1 : 0, rules});
    if (filter.enabled) disableAllBut(filter.id);
  });
}

/** An enabled filter disables every other row; an unknown id changes nothing. */
export function filtersUpdate(filter: ItemFilter): void {
  const rules = encodeRules(filter.rules);
  db.transaction(() => {
    const {changes} = db.prepare('UPDATE item_filters SET name = @name, enabled = @enabled, rules = @rules WHERE id = @id')
      .run({id: filter.id, name: filter.name, enabled: filter.enabled ? 1 : 0, rules});
    if (filter.enabled && changes > 0) disableAllBut(filter.id);
  });
}

export function filtersDelete(id: string): void {
  db.prepare('DELETE FROM item_filters WHERE id = ?').run(id);
}

export function filtersSetEnabled(id: string, enabled: boolean): void {
  // Use a transaction: disable all, then enable the target (or just disable all if enabled=false)
  db.transaction(() => {
    db.prepare('UPDATE item_filters SET enabled = 0').run();
    if (enabled) {
      db.prepare('UPDATE item_filters SET enabled = 1 WHERE id = ?').run(id);
    }
  });
}

function disableAllBut(id: string): void {
  db.prepare('UPDATE item_filters SET enabled = 0 WHERE id != ? AND enabled = 1').run(id);
}

/** A rules write's JSON; throws (nothing is stored) for a malformed payload. */
function encodeRules(rules: FilterRule[]): string {
  return JSON.stringify(decodeFilterRules(rules));
}

function decodeStoredRules(filterId: string, json: string): FilterRule[] {
  try {
    return decodeFilterRules(JSON.parse(json));
  } catch (err) {
    throw new Error(`Filter ${filterId} has unreadable rules: ${describeErrorBrief(err)}`);
  }
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
  return db.transaction((): {recorded: boolean; priceDate: number | null} => {
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
        const obsId = res.lastInsertRowid;
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
}

/**
 * One-time history backfill from wealth_datapoints.breakdown and sessions.price_snapshot
 * (compressed to change-points), plus each priced item's current items.price/price_date
 * when that is a newer AND different price than the item's last backfill point.
 * Guarded by the `price_backfill_done` setting, which is set in the same transaction.
 */
export function priceBackfillOnce(): {inserted: number; skipped: boolean} {
  if (settingsGet('price_backfill_done')) return {inserted: 0, skipped: true};

  const inserted = db.transaction(() => {
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
  return {inserted, skipped: false};
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
  });
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
