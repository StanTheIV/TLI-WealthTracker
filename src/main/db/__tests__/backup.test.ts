import {describe, it, expect, afterEach} from 'vitest';
import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {backupDb} from '@/main/db/backup';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, {recursive: true, force: true}); });

function tempUserData(): string {
  // An apostrophe in the path exercises the VACUUM INTO quoting.
  const dir = mkdtempSync(join(tmpdir(), "tli-backup-o'test-"));
  dirs.push(dir);
  return dir;
}

describe('backupDb', () => {
  it('writes a readable snapshot to backup-<date>-<reason>, suffixing repeats', () => {
    const userData = tempUserData();
    const conn     = openNodeSqlite();
    conn.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')");
    const now = new Date(2026, 9, 26, 12);

    const first  = backupDb(conn, userData, 'pre-test', now);
    const second = backupDb(conn, userData, 'pre-test', now);
    conn.close();

    expect(first).toBe(join(userData, 'backup-2026-10-26-pre-test', 'tli-tracker.db'));
    expect(second).toBe(join(userData, 'backup-2026-10-26-pre-test-2', 'tli-tracker.db'));
    const copy = openNodeSqlite(second);
    expect(copy.prepare('SELECT a FROM t').all()).toEqual([{a: 'x'}]);
    copy.close();
  });

  it('refuses a reason that is not a plain slug', () => {
    const conn = openNodeSqlite();
    expect(() => backupDb(conn, tempUserData(), '../escape')).toThrow(/Invalid backup reason/);
    conn.close();
  });
});
