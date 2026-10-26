import {Database} from 'bun:sqlite';
import {firstColumn, normalizeArgs, pragmaBody, type SqlConn, type SqlStatement} from '@/main/db/sql-conn';

type Row = Record<string, unknown>;

/** Replay driver: bun:sqlite (Bun can load neither better-sqlite3's Electron
 *  binary nor node:sqlite). `strict` binds bare keys and throws on missing params. */
export function openBunSqlite(path: string, opts: {readonly?: boolean} = {}): SqlConn {
  const db = new Database(path, {...opts, strict: true});

  const wrap = (stmt: ReturnType<Database['prepare']>): SqlStatement => ({
    run: (...args) => {
      const res = stmt.run(...normalizeArgs(args));
      return {changes: res.changes, lastInsertRowid: Number(res.lastInsertRowid)};
    },
    get: <T>(...args: unknown[]) => (stmt.get(...normalizeArgs(args)) ?? undefined) as T | undefined,   // bun: null → undefined
    all: <T>(...args: unknown[]) => stmt.all(...normalizeArgs(args)) as T[],
  });

  return {
    exec:        sql => { db.exec(sql); },
    prepare:     sql => wrap(db.prepare(sql)),
    transaction: fn => db.transaction(fn)(),
    getPragma:   name => firstColumn(db.prepare(`PRAGMA ${pragmaBody(name)}`).get() as Row | null),
    setPragma:   (name, value) => { db.exec(`PRAGMA ${pragmaBody(name, value)}`); },
    close:       () => { db.close(); },
  };
}
