import {DatabaseSync, type SQLInputValue, type StatementSync} from 'node:sqlite';
import {firstColumn, normalizeArgs, pragmaBody, type SqlConn, type SqlStatement} from '@/main/db/sql-conn';

type Row = Record<string, unknown>;

/** Test driver: node:sqlite (vitest runs under Node, where better-sqlite3's
 *  Electron-ABI binary can't load). */
export function openNodeSqlite(path = ':memory:'): SqlConn {
  const db = new DatabaseSync(path);
  let depth = 0;

  // Typed as positional for the spread; a lone named object binds the same at runtime.
  const bind = (args: unknown[]) => normalizeArgs(args) as SQLInputValue[];

  const wrap = (stmt: StatementSync): SqlStatement => {
    // node:sqlite throws on extra named keys; the contract ignores them.
    stmt.setAllowUnknownNamedParameters(true);
    return {
      run: (...args) => {
        const res = stmt.run(...bind(args));
        return {changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid)};
      },
      get: <T>(...args: unknown[]) => {
        const row = stmt.get(...bind(args)) as Row | undefined;
        return (row ? {...row} : undefined) as T | undefined;   // null-prototype → plain
      },
      all: <T>(...args: unknown[]) => (stmt.all(...bind(args)) as Row[]).map(r => ({...r})) as T[],
    };
  };

  return {
    exec:    sql => { db.exec(sql); },
    prepare: sql => wrap(db.prepare(sql)),
    transaction: <T>(fn: () => T): T => {
      const sp = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      depth++;
      try {
        const result = fn();
        db.exec(depth === 1 ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        if (db.isTransaction) db.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw err;
      } finally {
        depth--;
      }
    },
    getPragma: name => firstColumn(db.prepare(`PRAGMA ${pragmaBody(name)}`).get() as Row | undefined),
    setPragma: (name, value) => { db.exec(`PRAGMA ${pragmaBody(name, value)}`); },
    close:     () => { db.close(); },
  };
}
