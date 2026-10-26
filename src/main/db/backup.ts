import {existsSync, mkdirSync} from 'fs';
import {join} from 'path';
import {log} from '../logger';
import type {SqlConn} from './sql-conn';

const DB_FILE = 'tli-tracker.db';

function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Consistent snapshot via `VACUUM INTO <userData>/backup-<YYYY-MM-DD>-<reason>/tli-tracker.db`
 * (`-2`, `-3`, … when that exists). Must not run inside a transaction. Returns the file path.
 */
export function backupDb(conn: SqlConn, userDataDir: string, reason: string, now = new Date()): string {
  if (!/^[a-z0-9-]+$/i.test(reason)) throw new Error(`Invalid backup reason: ${reason}`);

  const base = `backup-${localDate(now)}-${reason}`;
  let dir    = join(userDataDir, base);
  for (let n = 2; existsSync(join(dir, DB_FILE)); n++) dir = join(userDataDir, `${base}-${n}`);

  mkdirSync(dir, {recursive: true});
  const target = join(dir, DB_FILE);
  conn.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  log.info('database', `Database backed up to ${target}`);
  return target;
}
