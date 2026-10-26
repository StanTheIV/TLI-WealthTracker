/**
 * SqlConn adapter contract (see src/main/db/sql-conn.ts), shared by the
 * node:sqlite vitest suite and the bun:sqlite check script. Plain
 * `node:assert` so it runs under both runtimes.
 */
import assert from 'node:assert/strict';
import type {SqlConn} from '@/main/db/sql-conn';

export interface ContractCase {
  name: string;
  run(conn: SqlConn): void;
}

function setup(conn: SqlConn): void {
  conn.exec(`
    CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, b INTEGER);
    CREATE TABLE u (x TEXT);
  `);
}

const count = (conn: SqlConn, where = '1') =>
  conn.prepare(`SELECT COUNT(*) AS n FROM t WHERE ${where}`).get<{n: number}>()!.n;

export const CONTRACT_CASES: ContractCase[] = [
  {
    name: 'multi-statement exec',
    run(conn) {
      setup(conn);
      assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('t', 'u')").get<{n: number}>()!.n, 2);
    },
  },
  {
    name: 'variadic positional params',
    run(conn) {
      setup(conn);
      conn.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('x', 7);
      assert.deepEqual(conn.prepare('SELECT a, b FROM t').get(), {a: 'x', b: 7});
    },
  },
  {
    name: 'named params bind bare keys; extra keys are ignored',
    run(conn) {
      setup(conn);
      conn.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({a: 'x', b: 1, extra: 'ignored', more: {}});
      assert.deepEqual(conn.prepare('SELECT a, b FROM t').get(), {a: 'x', b: 1});
    },
  },
  {
    name: 'undefined binds as NULL',
    run(conn) {
      setup(conn);
      conn.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({a: undefined, b: 1});
      conn.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(undefined, 2);
      assert.deepEqual(conn.prepare('SELECT a, b FROM t ORDER BY b').all(), [{a: null, b: 1}, {a: null, b: 2}]);
    },
  },
  {
    name: 'booleans bind as 1/0',
    run(conn) {
      setup(conn);
      conn.prepare('INSERT INTO t (b) VALUES (?)').run(true);
      conn.prepare('INSERT INTO t (b) VALUES (@b)').run({b: false});
      assert.deepEqual(conn.prepare('SELECT b FROM t ORDER BY id').all(), [{b: 1}, {b: 0}]);
    },
  },
  {
    name: 'get() returns undefined when there is no row',
    run(conn) {
      setup(conn);
      assert.equal(conn.prepare('SELECT * FROM t WHERE id = ?').get(999), undefined);
    },
  },
  {
    name: 'rows are plain objects',
    run(conn) {
      setup(conn);
      conn.prepare('INSERT INTO t (a) VALUES (?)').run('x');
      assert.equal(Object.getPrototypeOf(conn.prepare('SELECT a FROM t').get()), Object.prototype);
      assert.equal(Object.getPrototypeOf(conn.prepare('SELECT a FROM t').all()[0]), Object.prototype);
    },
  },
  {
    name: 'run() reports changes and a numeric lastInsertRowid',
    run(conn) {
      setup(conn);
      const ins = conn.prepare('INSERT INTO t (a) VALUES (?)');
      ins.run('x');
      const res = ins.run('y');
      assert.equal(typeof res.lastInsertRowid, 'number');
      assert.equal(res.lastInsertRowid, 2);
      assert.equal(res.changes, 1);
      assert.equal(conn.prepare('UPDATE t SET b = 1').run().changes, 2);
    },
  },
  {
    name: 'transaction returns the callback value and commits',
    run(conn) {
      setup(conn);
      const out = conn.transaction(() => conn.prepare('INSERT INTO t (a) VALUES (?)').run('x').changes);
      assert.equal(out, 1);
      assert.equal(count(conn), 1);
    },
  },
  {
    name: 'a throwing transaction rolls back and rethrows',
    run(conn) {
      setup(conn);
      assert.throws(() => conn.transaction(() => {
        conn.prepare('INSERT INTO t (a) VALUES (?)').run('x');
        throw new Error('boom');
      }), /boom/);
      assert.equal(count(conn), 0);
    },
  },
  {
    name: 'nested transaction rolls back only the inner savepoint',
    run(conn) {
      setup(conn);
      conn.transaction(() => {
        conn.prepare("INSERT INTO t (a) VALUES ('outer')").run();
        assert.throws(() => conn.transaction(() => {
          conn.prepare("INSERT INTO t (a) VALUES ('inner')").run();
          throw new Error('inner');
        }));
        conn.transaction(() => { conn.prepare("INSERT INTO t (a) VALUES ('inner-ok')").run(); });
      });
      assert.deepEqual(conn.prepare('SELECT a FROM t ORDER BY id').all(), [{a: 'outer'}, {a: 'inner-ok'}]);
    },
  },
  {
    name: 'an outer throw rolls back committed inner work too',
    run(conn) {
      setup(conn);
      assert.throws(() => conn.transaction(() => {
        conn.transaction(() => { conn.prepare("INSERT INTO t (a) VALUES ('inner')").run(); });
        throw new Error('outer');
      }), /outer/);
      assert.equal(count(conn), 0);
      // The connection is usable afterwards (no dangling transaction).
      conn.transaction(() => { conn.prepare("INSERT INTO t (a) VALUES ('after')").run(); });
      assert.equal(count(conn), 1);
    },
  },
  {
    name: 'getPragma / setPragma round-trip; non-identifier input is refused',
    run(conn) {
      assert.equal(conn.getPragma('user_version'), 0);
      conn.setPragma('user_version', 3);
      assert.equal(conn.getPragma('user_version'), 3);
      conn.setPragma('foreign_keys', 'ON');
      assert.equal(conn.getPragma('foreign_keys'), 1);
      assert.throws(() => conn.getPragma('user_version; DROP TABLE t'));
      assert.throws(() => conn.setPragma('user_version', '1; DROP TABLE t'));
    },
  },
];
