import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from './node-sqlite';

/** In-memory node:sqlite conn at the latest schema, without the db.ts
 *  singleton — for code that takes its SqlConn as a dependency. */
export function openMigratedNodeSqlite(): SqlConn {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  runMigrations(conn, MIGRATIONS, {backup: () => {}});
  return conn;
}
