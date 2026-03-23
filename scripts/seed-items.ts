/**
 * Standalone seed script — run with:
 *   bun run electron/scripts/seed-items.ts
 *
 * Reads data/full_table.json from the repo root and bulk-upserts all items
 * into the TLI Tracker SQLite database.
 *
 * DB path (matches what Electron uses via app.getPath('userData')):
 *   Windows: %APPDATA%\tli-tracker\tli-tracker.db
 */

// Use the root-level better-sqlite3 (built for system Node, not Electron's ABI)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(require.resolve('better-sqlite3', {paths: [__dirname + '/../../node_modules']})) as typeof import('better-sqlite3');
import {readFileSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';
import {mapRawType} from '../src/types/itemType';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getDbPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'tli-tracker', 'tli-tracker.db');
}

const REPO_ROOT    = join(__dirname, '..', '..');
const TABLE_PATH   = join(REPO_ROOT, 'data', 'full_table.json');
const DB_PATH      = getDbPath();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawEntry {
  name?:        string;
  type?:        string;
  price?:       number;
  last_update?: number;
  timestamp?:   number;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`DB:    ${DB_PATH}`);
console.log(`Table: ${TABLE_PATH}`);
console.log('');

const db = new Database(DB_PATH);

// Ensure the items table exists (in case app has never been opened)
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT '',
    price      REAL NOT NULL DEFAULT 0,
    price_date REAL NOT NULL DEFAULT 0
  );
`);

const raw: Record<string, RawEntry> = JSON.parse(readFileSync(TABLE_PATH, 'utf-8'));

const upsert = db.prepare(`
  INSERT INTO items (id, name, type, price, price_date)
  VALUES (@id, @name, @type, @price, @priceDate)
  ON CONFLICT(id) DO UPDATE SET
    name       = excluded.name,
    type       = excluded.type,
    price      = excluded.price,
    price_date = excluded.price_date
`);

const seed = db.transaction((entries: Record<string, RawEntry>) => {
  let count = 0;
  for (const [id, entry] of Object.entries(entries)) {
    const name      = entry.name && entry.name !== id ? entry.name : '';
    const type      = mapRawType(entry.type);
    const price     = entry.price ?? 0;
    const priceDate = entry.last_update ?? entry.timestamp ?? 0;
    upsert.run({id, name, type, price, priceDate});
    count++;
  }
  return count;
});

const count = seed(raw);
console.log(`Seeded ${count} items into ${DB_PATH}`);

db.close();
