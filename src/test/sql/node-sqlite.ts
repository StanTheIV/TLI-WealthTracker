import {DatabaseSync, type SQLInputValue, type StatementSync} from 'node:sqlite';
import {firstColumn, normalizeArgs, pragmaBody, type SqlConn, type SqlStatement} from '@/main/db/sql-conn';

type Row = Record<string, unknown>;

/** Test driver: node:sqlite (built into Node — keeps the app's native
 *  better-sqlite3 out of the test path). */
export function openNodeSqlite(path = ':memory:'): SqlConn {
  const db = new DatabaseSync(path);
  let depth = 0;

  // Typed as positional for the spread; a lone named object binds the same at runtime.
  const bind = (args: unknown[]) => normalizeArgs(args) as SQLInputValue[];

  // node:sqlite silently binds NULL for a named param the object omits; better-sqlite3 and
  // bun:sqlite (strict) throw. Match them.
  const namedParams = (sql: string): string[] => {
    const bare = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
    return [...bare.matchAll(/[@:$]([A-Za-z_]\w*)/g)].map(m => m[1]);
  };
  const requireNamed = (names: string[], args: unknown[]): void => {
    const bound = args[0];
    if (args.length !== 1 || typeof bound !== 'object' || bound === null || Array.isArray(bound) || ArrayBuffer.isView(bound)) return;
    for (const n of names) {
      if (!(n in bound)) throw new Error(`Missing named parameter "${n}"`);
    }
  };

  const wrap = (stmt: StatementSync, sql: string): SqlStatement => {
    const names = namedParams(sql);
    // node:sqlite throws on extra named keys; the contract ignores them.
    stmt.setAllowUnknownNamedParameters(true);
    return {
      run: (...args) => {
        requireNamed(names, args);
        const res = stmt.run(...bind(args));
        return {changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid)};
      },
      get: <T>(...args: unknown[]) => {
        requireNamed(names, args);
        const row = stmt.get(...bind(args)) as Row | undefined;
        return (row ? {...row} : undefined) as T | undefined;   // null-prototype → plain
      },
      all: <T>(...args: unknown[]) => {
        requireNamed(names, args);
        return (stmt.all(...bind(args)) as Row[]).map(r => ({...r})) as T[];
      },
    };
  };

  return {
    exec:    sql => { db.exec(sql); },
    prepare: sql => wrap(db.prepare(sql), sql),
    transaction: <T>(fn: () => T): T => {
      const sp     = `sp${depth}`;
      // Nest whenever SQLite is already in a transaction (even a manual BEGIN), like bs3 and bun.
      const nested = db.isTransaction;
      db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN');
      depth++;
      try {
        const result = fn();
        db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
        return result;
      } catch (err) {
        if (db.isTransaction) db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
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
