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

/** Parent/child shaped like sessions/session_maps: FK with cascade, partial unique on primaries. */
function fkSetup(conn: SqlConn): void {
  conn.exec(`
    CREATE TABLE p (id TEXT PRIMARY KEY);
    CREATE TABLE c (id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL REFERENCES p(id) ON DELETE CASCADE, k INTEGER NOT NULL, parent INTEGER);
    CREATE UNIQUE INDEX c_primary ON c (pid, k) WHERE parent IS NULL;
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
    name: 'get() on a PRAGMA returns a plain row; all() with zero rows is []',
    run(conn) {
      setup(conn);
      assert.deepEqual(conn.prepare('PRAGMA user_version').get(), {user_version: 0});
      assert.deepEqual(conn.prepare('SELECT * FROM t').all(), []);
      assert.deepEqual(conn.prepare('PRAGMA table_info(u)').all().map(r => (r as {name: string}).name), ['x']);
    },
  },
  {
    name: 'a named param missing from the object throws',
    run(conn) {
      setup(conn);
      assert.throws(() => conn.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({a: 'x'}));
      assert.throws(() => conn.prepare('SELECT * FROM t WHERE a = @a').all({}));
      assert.equal(count(conn), 0);
    },
  },
  {
    name: 'BLOB / Uint8Array round-trips',
    run(conn) {
      conn.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)');
      const bytes = new Uint8Array([0, 1, 2, 255, 128]);
      conn.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(1, bytes);
      conn.prepare('INSERT INTO blobs (id, data) VALUES (@id, @data)').run({id: 2, data: bytes});
      for (const id of [1, 2]) {
        const row = conn.prepare('SELECT data FROM blobs WHERE id = ?').get<{data: Uint8Array}>(id)!;
        assert.ok(row.data instanceof Uint8Array);
        assert.deepEqual([...row.data], [0, 1, 2, 255, 128]);
      }
    },
  },
  {
    // sessions.ended_at (v4): NULL = live, else an ms epoch read back as an exact number.
    name: 'null binds as NULL; integer ms epochs (negative, 2^53 − 1) round-trip as exact numbers',
    run(conn) {
      setup(conn);
      const ins = conn.prepare('INSERT INTO t (b) VALUES (?)');
      for (const v of [null, -1000, 0, 1_790_000_000_000, Number.MAX_SAFE_INTEGER]) ins.run(v);
      conn.prepare('INSERT INTO t (b) VALUES (@b)').run({b: null});
      const rows = conn.prepare('SELECT b, typeof(b) AS ty FROM t ORDER BY id').all<{b: number | null; ty: string}>();
      assert.deepEqual(rows.map(r => r.b), [null, -1000, 0, 1_790_000_000_000, Number.MAX_SAFE_INTEGER, null]);
      assert.deepEqual(rows.map(r => r.ty), ['null', 'integer', 'integer', 'integer', 'integer', 'null']);
      assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM t WHERE b IS NULL').get<{n: number}>()!.n, 2);
    },
  },
  {
    name: 'bigint input binds as an integer',
    run(conn) {
      setup(conn);
      conn.prepare('INSERT INTO t (b) VALUES (?)').run(9007199254740993n);
      conn.prepare('INSERT INTO t (b) VALUES (@b)').run({b: 5n});
      const rows = conn.prepare('SELECT CAST(b AS TEXT) AS s FROM t ORDER BY id').all<{s: string}>();
      assert.deepEqual(rows.map(r => r.s), ['9007199254740993', '5']);
    },
  },
  {
    name: 'a prepared statement is reusable across transaction boundaries',
    run(conn) {
      setup(conn);
      const ins = conn.prepare('INSERT INTO t (a) VALUES (?)');
      ins.run('before');
      conn.transaction(() => { ins.run('in-tx'); });
      assert.throws(() => conn.transaction(() => { ins.run('rolled-back'); throw new Error('x'); }));
      ins.run('after');
      assert.deepEqual(conn.prepare('SELECT a FROM t ORDER BY id').all(), [{a: 'before'}, {a: 'in-tx'}, {a: 'after'}]);
    },
  },
  {
    name: 'inner SQL failure caught inside the outer transaction: outer continues and commits',
    run(conn) {
      setup(conn);
      const out = conn.transaction(() => {
        conn.prepare("INSERT INTO t (a) VALUES ('o1')").run();
        try {
          conn.transaction(() => {
            conn.prepare("INSERT INTO t (a) VALUES ('i')").run();
            conn.prepare('INSERT INTO nope (a) VALUES (1)').run();   // real SQL error, not a JS throw
          });
        } catch { /* swallowed by caller */ }
        conn.prepare("INSERT INTO t (a) VALUES ('o2')").run();
        return 'done';
      });
      assert.equal(out, 'done');
      assert.deepEqual(conn.prepare('SELECT a FROM t ORDER BY id').all(), [{a: 'o1'}, {a: 'o2'}]);
      conn.transaction(() => { conn.prepare("INSERT INTO t (a) VALUES ('next')").run(); });
      assert.equal(count(conn), 3);
    },
  },
  {
    name: 'a UNIQUE violation in a nested transaction caught by the caller leaves the connection usable',
    run(conn) {
      conn.exec('CREATE TABLE k (id INTEGER PRIMARY KEY)');
      conn.transaction(() => {
        conn.prepare('INSERT INTO k (id) VALUES (1)').run();
        assert.throws(() => conn.transaction(() => { conn.prepare('INSERT INTO k (id) VALUES (1)').run(); }));
        conn.prepare('INSERT INTO k (id) VALUES (2)').run();
      });
      assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM k').get<{n: number}>()!.n, 2);
    },
  },
  {
    name: 'transaction inside a manual BEGIN nests as a savepoint and leaves the outer BEGIN open',
    run(conn) {
      setup(conn);
      conn.exec('BEGIN');
      conn.transaction(() => { conn.prepare("INSERT INTO t (a) VALUES ('in')").run(); });
      assert.throws(() => conn.transaction(() => { conn.prepare("INSERT INTO t (a) VALUES ('gone')").run(); throw new Error('x'); }));
      conn.exec('ROLLBACK');   // the manual transaction was still open: everything goes
      assert.equal(count(conn), 0);
    },
  },
  // session_maps (v5): FK to sessions with cascade, a partial unique index, and a
  // foreignKeysOff rebuild. Drivers default foreign_keys differently, so set it.
  {
    name: 'foreign keys ON: a parent delete cascades; an orphan insert throws',
    run(conn) {
      conn.setPragma('foreign_keys', 'ON');
      fkSetup(conn);
      conn.exec("INSERT INTO p VALUES ('a'), ('b'); INSERT INTO c (pid, k) VALUES ('a', 1), ('a', 2), ('b', 1)");
      conn.prepare('DELETE FROM p WHERE id = ?').run('a');
      assert.deepEqual(conn.prepare('SELECT pid, k FROM c').all(), [{pid: 'b', k: 1}]);
      assert.throws(() => conn.prepare('INSERT INTO c (pid, k) VALUES (?, ?)').run('ghost', 1), /FOREIGN KEY/);
      assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM c').get<{n: number}>()!.n, 1);
    },
  },
  {
    name: 'a partial unique index refuses a duplicate inside its WHERE and allows one outside it',
    run(conn) {
      conn.setPragma('foreign_keys', 'ON');
      fkSetup(conn);
      conn.exec("INSERT INTO p VALUES ('a'); INSERT INTO c (pid, k, parent) VALUES ('a', 1, NULL), ('a', 1, 1)");
      assert.throws(() => conn.prepare('INSERT INTO c (pid, k, parent) VALUES (?, ?, ?)').run('a', 1, null), /UNIQUE/);
      conn.prepare('INSERT INTO c (pid, k, parent) VALUES (?, ?, ?)').run('a', 1, 1);
      assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM c').get<{n: number}>()!.n, 3);
      const idx = conn.prepare('PRAGMA index_list(c)').all<{name: string; unique: number; partial: number}>().find(i => i.name === 'c_primary');
      assert.equal(idx?.unique, 1);
      assert.equal(idx?.partial, 1);
    },
  },
  {
    name: 'foreign keys OFF: a parent delete leaves its children; foreign_key_check returns the violating row',
    run(conn) {
      conn.setPragma('foreign_keys', 'OFF');
      fkSetup(conn);
      conn.exec("INSERT INTO p VALUES ('a'); INSERT INTO c (pid, k) VALUES ('a', 1)");
      conn.prepare('DELETE FROM p').run();
      assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM c').get<{n: number}>()!.n, 1);
      assert.deepEqual(conn.prepare('PRAGMA foreign_key_check').all(), [{table: 'c', rowid: 1, parent: 'p', fkid: 0}]);
    },
  },
  {
    name: 'setting foreign_keys inside a transaction has no effect',
    run(conn) {
      conn.setPragma('foreign_keys', 'ON');
      fkSetup(conn);
      conn.exec("INSERT INTO p VALUES ('a'); INSERT INTO c (pid, k) VALUES ('a', 1)");
      conn.transaction(() => {
        conn.setPragma('foreign_keys', 'OFF');
        assert.equal(conn.getPragma('foreign_keys'), 1);
        conn.prepare('DELETE FROM p').run();
      });
      assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM c').get<{n: number}>()!.n, 0);   // still cascaded
      assert.equal(conn.getPragma('foreign_keys'), 1);
    },
  },
  {
    name: 'table rebuild (CREATE new, INSERT SELECT, DROP, RENAME) inside a transaction: sqlite_sequence carried over by hand, no id reused, one entry',
    run(conn) {
      conn.setPragma('foreign_keys', 'OFF');
      conn.exec(`
        CREATE TABLE p (id TEXT PRIMARY KEY);
        CREATE TABLE c (id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL, k INTEGER NOT NULL);
        INSERT INTO p VALUES ('a');
        INSERT INTO c (pid, k) VALUES ('a', 1), ('a', 2), ('a', 3);
        DELETE FROM c WHERE k = 3;
      `);
      const seq = () => conn.prepare("SELECT name, seq FROM sqlite_sequence WHERE name LIKE 'c%'").all();
      assert.deepEqual(seq(), [{name: 'c', seq: 3}]);
      conn.transaction(() => {
        const oldSeq = conn.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'c'").get<{seq: number}>()!.seq;
        conn.exec(`
          CREATE TABLE c_new (id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL REFERENCES p(id) ON DELETE CASCADE, k INTEGER NOT NULL);
          INSERT INTO c_new (id, pid, k) SELECT id, pid, k FROM c;
          DROP TABLE c;
          ALTER TABLE c_new RENAME TO c;
        `);
        const cur = conn.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'c'").get<{seq: number}>()?.seq;
        if (cur === undefined) conn.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('c', ?)").run(oldSeq);
        else if (oldSeq > cur) conn.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'c'").run(oldSeq);
      });
      assert.deepEqual(seq(), [{name: 'c', seq: 3}]);
      assert.equal(conn.prepare("INSERT INTO c (pid, k) VALUES ('a', 9)").run().lastInsertRowid, 4);
      assert.deepEqual(seq(), [{name: 'c', seq: 4}]);
    },
  },
  {
    name: 'ALTER TABLE … DROP COLUMN keeps the other columns, rows and AUTOINCREMENT sequence',
    run(conn) {
      setup(conn);
      conn.exec("INSERT INTO t (id, a, b) VALUES (5, 'x', 1), (9, 'y', 2)");
      conn.exec('ALTER TABLE t DROP COLUMN b');
      assert.deepEqual(conn.prepare('PRAGMA table_info(t)').all().map(r => (r as {name: string}).name), ['id', 'a']);
      assert.deepEqual(conn.prepare('SELECT * FROM t ORDER BY id').all(), [{id: 5, a: 'x'}, {id: 9, a: 'y'}]);
      assert.equal(conn.prepare("INSERT INTO t (a) VALUES ('z')").run().lastInsertRowid, 10);
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
