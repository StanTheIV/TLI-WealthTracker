import Database from 'better-sqlite3';
import {normalizeArgs, pragmaBody, type SqlConn, type SqlStatement} from '../sql-conn';

/** The app's driver. Loads only under Electron (native ABI) — never import it
 *  from anything vitest or Bun loads. */
export function openBetterSqlite3(path: string, opts?: Database.Options): SqlConn {
  const db = new Database(path, opts);

  const wrap = (stmt: Database.Statement): SqlStatement => ({
    run: (...args) => {
      const res = stmt.run(...normalizeArgs(args));
      return {changes: res.changes, lastInsertRowid: Number(res.lastInsertRowid)};
    },
    get: <T>(...args: unknown[]) => stmt.get(...normalizeArgs(args)) as T | undefined,
    all: <T>(...args: unknown[]) => stmt.all(...normalizeArgs(args)) as T[],
  });

  return {
    exec:        sql => { db.exec(sql); },
    prepare:     sql => wrap(db.prepare(sql)),
    // bs3's own wrapper: BEGIN/COMMIT/ROLLBACK, savepoints when nested.
    transaction: fn => db.transaction(fn)(),
    getPragma:   name => db.pragma(pragmaBody(name), {simple: true}),
    setPragma:   (name, value) => { db.pragma(pragmaBody(name, value)); },
    close:       () => { db.close(); },
  };
}
