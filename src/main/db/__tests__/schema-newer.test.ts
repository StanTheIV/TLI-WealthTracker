/**
 * Step 1.2 commit A (test-first) — report a schema newer than the app.
 *
 * Expected from the implementation (absent today):
 *   - `runMigrations(...)` returns `MigrationResult`
 *       {from: number; to: number; latest: number; newerThanApp: boolean}
 *     exported as a type from src/main/db/migrations.ts. `from` = user_version
 *     before, `to` = after, `latest` = highest known migration version. When
 *     `from > latest`: `log.warn('database', ...)`, no writes, no backup.
 *   - `initDb(conn, opts)` (src/main/db.ts) returns the same result.
 *   - `newerSchemaMessage(result): string | null` exported from
 *     src/main/db/schema-newer.ts (pure, English).
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations, type Migration} from '@/main/db/migrations';
import {initDb} from '@/main/db';
import {log} from '@/main/logger';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

interface MigrationResult {from: number; to: number; latest: number; newerThanApp: boolean}
type NewerSchemaMessage = (result: MigrationResult) => string | null;

const MESSAGE_MODULE = '@/main/db/schema-newer';

async function loadMessage(): Promise<NewerSchemaMessage> {
  let mod: {newerSchemaMessage?: NewerSchemaMessage};
  try {
    mod = await import(/* @vite-ignore */ MESSAGE_MODULE);
  } catch (err) {
    throw new Error(`module ${MESSAGE_MODULE} is missing: ${(err as Error).message}`);
  }
  if (typeof mod.newerSchemaMessage !== 'function') throw new Error('schema-newer must export newerSchemaMessage');
  return mod.newerSchemaMessage;
}

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

const conns: SqlConn[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (conns.length) conns.pop()!.close();
});

function open(): SqlConn {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  conns.push(conn);
  return conn;
}

const version = (c: SqlConn) => Number(c.getPragma('user_version'));
const tables  = (c: SqlConn) => c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const step = (v: number, up: Migration['up'] = () => {}, extra: Partial<Migration> = {}): Migration => ({version: v, name: `m${v}`, up, ...extra});
/** The runner's return value, typed for the not-yet-existing contract. */
const run = (c: SqlConn, migrations: readonly Migration[], backup: (r: string) => void = () => {}) =>
  runMigrations(c, migrations, {backup}) as unknown as MigrationResult;

describe('runMigrations result', () => {
  it('fresh DB: from 0 to latest, not newer, no backup', () => {
    const backup = vi.fn();
    expect(run(open(), MIGRATIONS, backup)).toEqual({from: 0, to: LATEST, latest: LATEST, newerThanApp: false});
    expect(backup).not.toHaveBeenCalled();
  });

  it('up-to-date DB: from = to = latest, nothing written', () => {
    const conn = open();
    runMigrations(conn, MIGRATIONS, {backup: () => {}});
    const backup = vi.fn();
    expect(run(conn, MIGRATIONS, backup)).toEqual({from: LATEST, to: LATEST, latest: LATEST, newerThanApp: false});
    expect(backup).not.toHaveBeenCalled();
  });

  it('pending steps: from the old version to the new latest', () => {
    const conn = open();
    runMigrations(conn, [step(1, c => c.exec('CREATE TABLE a (x)'))], {backup: () => {}});
    const result = run(conn, [step(1), step(2, c => c.exec('CREATE TABLE b (x)')), step(3)]);
    expect(result).toEqual({from: 1, to: 3, latest: 3, newerThanApp: false});
    expect(version(conn)).toBe(3);
  });

  it('a v0 DB with data through the real migrations: from 0 to latest', () => {
    const conn = open();
    MIGRATIONS[0].up(conn);
    conn.setPragma('user_version', 0);
    expect(run(conn, MIGRATIONS)).toEqual({from: 0, to: LATEST, latest: LATEST, newerThanApp: false});
  });

  it('newer DB: reported as newerThanApp, nothing written, no backup, one warning', () => {
    const conn = open();
    runMigrations(conn, MIGRATIONS, {backup: () => {}});
    conn.setPragma('user_version', 99);
    conn.exec('CREATE TABLE future_table (x)');
    const before = tables(conn);
    const warn   = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const backup = vi.fn();

    expect(run(conn, MIGRATIONS, backup)).toEqual({from: 99, to: 99, latest: LATEST, newerThanApp: true});

    expect(version(conn)).toBe(99);
    expect(tables(conn)).toEqual(before);
    expect(backup).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('database', expect.stringContaining('99'));
  });

  it('one version above latest is already newer; exactly latest is not', () => {
    const above = open();
    above.setPragma('user_version', LATEST + 1);
    expect(run(above, MIGRATIONS)).toMatchObject({from: LATEST + 1, to: LATEST + 1, newerThanApp: true});

    const exact = open();
    exact.setPragma('user_version', LATEST);
    expect(run(exact, MIGRATIONS)).toMatchObject({from: LATEST, to: LATEST, newerThanApp: false});
  });

  it('a throwing step still throws (the result contract does not swallow failures)', () => {
    const conn = open();
    expect(() => run(conn, [step(1, () => { throw new Error('boom'); })])).toThrow('boom');
    expect(version(conn)).toBe(0);
  });
});

describe('initDb result', () => {
  it('returns the migration result for a fresh DB', () => {
    const result = initDb(open(), {backup: () => {}}) as unknown as MigrationResult;
    expect(result).toEqual({from: 0, to: LATEST, latest: LATEST, newerThanApp: false});
  });

  it('returns newerThanApp for a newer DB and leaves it untouched', () => {
    const conn = open();
    runMigrations(conn, MIGRATIONS, {backup: () => {}});
    conn.setPragma('user_version', 7);
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const result = initDb(conn, {backup: () => { throw new Error('no backup expected'); }}) as unknown as MigrationResult;

    expect(result).toEqual({from: 7, to: 7, latest: LATEST, newerThanApp: true});
    expect(version(conn)).toBe(7);
  });
});

describe('newerSchemaMessage', () => {
  it('null when the DB is not newer', async () => {
    const message = await loadMessage();
    expect(message({from: 0, to: LATEST, latest: LATEST, newerThanApp: false})).toBeNull();
    expect(message({from: LATEST, to: LATEST, latest: LATEST, newerThanApp: false})).toBeNull();
  });

  it('the exact warning text for a newer DB, naming both versions', async () => {
    const message = await loadMessage();
    expect(message({from: 7, to: 7, latest: 2, newerThanApp: true})).toBe(
      'This database was created by a newer version of TLI Tracker (schema v7; this version knows v2). '
      + 'Continuing may misread or overwrite data. Update TLI Tracker to avoid problems.',
    );
  });

  it('is pure: the same input gives the same output', async () => {
    const message = await loadMessage();
    const input = {from: 3, to: 3, latest: 2, newerThanApp: true};
    expect(message(input)).toBe(message({...input}));
    expect(input).toEqual({from: 3, to: 3, latest: 2, newerThanApp: true});
  });
});
