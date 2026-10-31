/**
 * 5.1d: initDb split into adoptDb (pragmas) + migrateDb (migrations + data
 * fixes), so main.ts can start the logger in between — on a connection whose
 * settings table may not exist yet.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import type {SqlConn} from '@/main/db/sql-conn';

// db.ts and the logger keep module-level state: a fresh graph per test.
async function fresh() {
  vi.resetModules();
  const db     = await import('@/main/db');
  const logger = await import('@/main/logger');
  return {...db, ...logger};
}

const noBackup = () => { throw new Error('fresh DB must not back up'); };

function schema(conn: SqlConn) {
  return conn.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tli-adopt-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, {recursive: true, force: true});
});

describe('adoptDb + migrateDb', () => {
  it('adoptDb then migrateDb yields the same schema, pragmas and result as initDb', async () => {
    const a = await fresh();
    const viaInit = openNodeSqlite();
    const initResult = a.initDb(viaInit, {backup: noBackup});

    const b = await fresh();
    const viaSplit = openNodeSqlite();
    b.adoptDb(viaSplit);
    const splitResult = b.migrateDb({backup: noBackup});

    expect(splitResult).toEqual(initResult);
    expect(schema(viaSplit)).toEqual(schema(viaInit));
    expect(viaSplit.getPragma('user_version')).toBe(viaInit.getPragma('user_version'));
    expect(viaSplit.getPragma('foreign_keys')).toBe(1);
  });

  it('adoptDb alone sets the pragmas and runs no migration', async () => {
    const {adoptDb, getDb} = await fresh();
    const conn = openNodeSqlite();
    adoptDb(conn);
    expect(getDb()).toBe(conn);
    expect(conn.getPragma('foreign_keys')).toBe(1);
    expect(conn.getPragma('user_version')).toBe(0);
    expect(schema(conn)).toEqual([]);
  });

  it('migrateDb before adoptDb throws (no connection)', async () => {
    const {migrateDb} = await fresh();
    expect(() => migrateDb({backup: noBackup})).toThrow('Database not initialized');
  });

  it('migrateDb normalises empty item types like initDb', async () => {
    const {adoptDb, migrateDb, itemsImportBatch, itemsGetAll} = await fresh();
    const conn = openNodeSqlite();
    adoptDb(conn);
    migrateDb({backup: noBackup});
    itemsImportBatch([{id: '1', name: 'X', type: '', price: 0, priceDate: 0}]);
    migrateDb({backup: noBackup});
    expect(itemsGetAll()[0].type).toBe('other');
  });
});

describe('the logger between adoptDb and migrateDb (main.ts order)', () => {
  it('settingsGetAll throws before the migrations; the logger falls back to its defaults (file: warn + error)', async () => {
    const {adoptDb, migrateDb, settingsGetAll, initLogger, log} = await fresh();
    adoptDb(openNodeSqlite());
    expect(() => settingsGetAll()).toThrow(); // no settings table on a fresh DB

    const file = join(dir, 'app.log');
    expect(() => initLogger({logFile: file, settings: settingsGetAll})).not.toThrow();
    log.info('database', 'not in the file');
    log.error('database', 'early error');
    expect(readFileSync(file, 'utf8')).toContain('early error');
    expect(readFileSync(file, 'utf8')).not.toContain('not in the file');

    migrateDb({backup: noBackup});
    expect(() => log.reloadConfig()).not.toThrow();
  });

  it('5.1e: the logger starts BEFORE any DB is adopted — the reader throws, defaults apply, an error reaches the file', async () => {
    const {settingsGetAll, initLogger, log} = await fresh();
    expect(() => settingsGetAll()).toThrow('Database not initialized');

    const file = join(dir, 'pre-db.log');
    expect(() => initLogger({logFile: file, settings: settingsGetAll})).not.toThrow();
    log.error('app', 'Startup failed: cannot open the database');
    log.info('app', 'not in the file');
    expect(readFileSync(file, 'utf8')).toContain('Startup failed: cannot open the database');
    expect(readFileSync(file, 'utf8')).not.toContain('not in the file');
    expect(() => log.reloadConfig()).not.toThrow();
  });

  it('5.1e: reloadConfig right after adoptDb applies an existing DB\'s stored config to the migrations', async () => {
    const conn = openNodeSqlite();
    const first = await fresh();
    first.initDb(conn, {backup: noBackup});
    first.settingsSet('logging.file', JSON.stringify({enabled: true, features: ['database'], types: ['info']}));

    const {adoptDb, settingsGetAll, initLogger, log} = await fresh();
    const file = join(dir, 'stored.log');
    initLogger({logFile: file, settings: settingsGetAll});
    log.info('database', 'before adopt');
    adoptDb(conn);
    log.reloadConfig();
    log.info('database', 'after adopt');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('after adopt');
    expect(text).not.toContain('before adopt');
  });

  it('after migrateDb, reloadConfig respects a stored logging.file', async () => {
    const {adoptDb, migrateDb, settingsGetAll, settingsSet, initLogger, log} = await fresh();
    adoptDb(openNodeSqlite());
    const file = join(dir, 'off.log');
    initLogger({logFile: file, settings: settingsGetAll});
    migrateDb({backup: noBackup});
    settingsSet('logging.file', JSON.stringify({enabled: false, features: ['database'], types: ['error']}));
    log.reloadConfig();
    log.error('database', 'x');
    expect(existsSync(file)).toBe(false);
  });
});
