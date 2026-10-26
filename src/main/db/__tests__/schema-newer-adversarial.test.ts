/** Step 1.2 adversarial — downgrade boundary and `latest` of degenerate migration lists. */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations, type Migration} from '@/main/db/migrations';
import {newerSchemaMessage} from '@/main/db/schema-newer';
import {log} from '@/main/logger';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const conns: SqlConn[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (conns.length) conns.pop()!.close();
});
const open = (): SqlConn => { const c = openNodeSqlite(); conns.push(c); return c; };
const step = (v: number): Migration => ({version: v, name: `m${v}`, up: () => {}});

describe('downgrade boundary', () => {
  it('user_version == latest is not newer: no warning, no backup, nothing run', () => {
    const conn = open();
    conn.setPragma('user_version', LATEST);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const backups: string[] = [];
    const r = runMigrations(conn, MIGRATIONS, {backup: x => backups.push(x)});
    expect(r).toEqual({from: LATEST, to: LATEST, latest: LATEST, newerThanApp: false});
    expect(warn).not.toHaveBeenCalled();
    expect(backups).toEqual([]);
    expect(newerSchemaMessage(r)).toBeNull();
  });

  it('user_version == latest + 1 is newer: one warning, untouched, message names both versions', () => {
    const conn = open();
    conn.setPragma('user_version', LATEST + 1);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const backups: string[] = [];
    const r = runMigrations(conn, MIGRATIONS, {backup: x => backups.push(x)});
    expect(r).toEqual({from: LATEST + 1, to: LATEST + 1, latest: LATEST, newerThanApp: true});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(backups).toEqual([]);
    expect(Number(conn.getPragma('user_version'))).toBe(LATEST + 1);
    expect(newerSchemaMessage(r)).toContain(`schema v${LATEST + 1}`);
    expect(newerSchemaMessage(r)).toContain(`knows v${LATEST}`);
    expect(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });

  it('a hugely newer version is still reported and untouched', () => {
    const conn = open();
    conn.setPragma('user_version', 2 ** 31 - 1);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const r = runMigrations(conn, MIGRATIONS, {backup: () => { throw new Error('no backup'); }});
    expect(r.newerThanApp).toBe(true);
    expect(r.from).toBe(2 ** 31 - 1);
  });

  it('latest is 0 for an empty migration list; a fresh DB is not newer', () => {
    const conn = open();
    const r = runMigrations(conn, [], {backup: () => {}});
    expect(r).toEqual({from: 0, to: 0, latest: 0, newerThanApp: false});
  });

  it('latest is 0 for an empty list and any user_version > 0 is newer', () => {
    const conn = open();
    conn.setPragma('user_version', 1);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const r = runMigrations(conn, [], {backup: () => {}});
    expect(r).toEqual({from: 1, to: 1, latest: 0, newerThanApp: true});
  });

  it('an unordered list is rejected rather than guessing latest', () => {
    expect(() => runMigrations(open(), [step(3), step(1)], {backup: () => {}})).toThrow(/strictly increasing/);
  });

  it('the message is null whenever newerThanApp is false, whatever the numbers', () => {
    expect(newerSchemaMessage({from: 9, to: 9, latest: 1, newerThanApp: false})).toBeNull();
    expect(newerSchemaMessage({from: 0, to: 0, latest: 0, newerThanApp: false})).toBeNull();
  });
});
