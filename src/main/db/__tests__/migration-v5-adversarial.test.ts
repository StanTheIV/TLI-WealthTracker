/**
 * Migration v5 `session-integrity` against hostile v4 data. The contract: v5 deletes exactly the
 * sessions with a duplicated PRIMARY (session_id, map_index) and nothing else; every other row is
 * byte-identical (ids included); no row id is ever reused; the DB ends with the FK cascade and the
 * partial unique enforced; attribution is never '' afterwards; a second run changes nothing; a
 * failing step rolls back everything.
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import {SqliteSessionStore} from '@/main/db/session-store';
import {closeCrashedSessions} from '@/main/session-recovery';
import {log} from '@/main/logger';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

const conns: SqlConn[] = [];
afterEach(() => {
  while (conns.length) conns.pop()!.close();
  vi.restoreAllMocks();
});

function open(): SqlConn {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  conns.push(conn);
  return conn;
}

const UP_TO_V4 = MIGRATIONS.slice(0, 4);
const version  = (c: SqlConn) => Number(c.getPragma('user_version'));
const migrate  = (c: SqlConn) => runMigrations(c, MIGRATIONS, {backup: () => {}});
const all      = <T = Record<string, unknown>>(c: SqlConn, sql: string, ...args: unknown[]) => c.prepare(sql).all<T>(...args);

function v4Db(): SqlConn {
  const c = open();
  runMigrations(c, UP_TO_V4, {backup: () => {}});
  return c;
}

function addSession(c: SqlConn, id: string, o: {attribution?: string; dbs?: string; endedAt?: number | null; savedAt?: string; totalTime?: number} = {}): void {
  c.prepare(`INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops, drops_by_source, attribution, price_snapshot, spent, ended_at)
             VALUES (?, ?, ?, ?, 50, 2, '{"100":3}', ?, ?, '{"100":1.5}', '{"300":2}', ?)`)
    .run(id, `Name ${id}`, o.savedAt ?? '2026-10-01T00:00:00.000Z', o.totalTime ?? 60, o.dbs ?? '{"map":{"100":3}}', o.attribution ?? 'drop-through',
      o.endedAt === undefined ? 5000 : o.endedAt);
}

/** [mapIndex, parentMapIndex | null, seasonalType | null] */
type R = [number, number | null, string | null];
const P  = (i: number): R => [i, null, null];
const OV = (parent: number, type = 'arcana'): R => [parent, parent, type];

let tick = 0;
function addRows(c: SqlConn, sessionId: string, rows: R[]): void {
  for (const [mi, parent, st] of rows) {
    c.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, ended_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
               VALUES (?, ?, ?, ?, 500, '{"100":1}', '{"7":1}', ?, ?, ?)`)
      .run(sessionId, mi, 1000 + ++tick, 2000 + tick, st, parent, st === 'sandlord' ? 'hub' : null);
  }
}

/** v4 DBs can hold dup primaries and orphans: the v4 table has neither an FK nor the unique index. */
const rowsAll    = (c: SqlConn) => all(c, 'SELECT * FROM session_maps ORDER BY id');
const sessionIds = (c: SqlConn) => all<{id: string}>(c, 'SELECT id FROM sessions ORDER BY id').map(r => r.id);
const maxId      = (c: SqlConn) => c.prepare('SELECT MAX(id) AS m FROM session_maps').get<{m: number | null}>()!.m;
const seqRows    = (c: SqlConn) => all<{name: string; seq: number}>(c, "SELECT name, seq FROM sqlite_sequence WHERE name LIKE 'session_maps%'");
const logged     = (spy: {mock: {calls: unknown[][]}}) => spy.mock.calls.map(call => call.map(String).join(' '));

/** Every table the migration must not touch, dumped. */
function untouched(c: SqlConn): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const tables = all<{name: string}>(c, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(t => t.name);
  for (const t of tables) {
    if (['sessions', 'session_maps', 'seasonal_stats', 'wealth_datapoints'].includes(t)) continue;
    out[t] = all(c, `SELECT * FROM ${t}`);
  }
  return out;
}

describe('v5 duplicate rule: exactly a duplicated PRIMARY (session_id, map_index)', () => {
  function build(): SqlConn {
    const c = v4Db();
    addSession(c, 'clean');             addRows(c, 'clean', [P(1), OV(1), P(2)]);
    addSession(c, 'dupZero');           addRows(c, 'dupZero', [P(0), P(0)]);                   // index 0 duplicated
    addSession(c, 'triple');            addRows(c, 'triple', [P(1), P(1), P(1), P(2)]);
    addSession(c, 'dupNegative');       addRows(c, 'dupNegative', [P(-1), P(-1)]);
    addSession(c, 'singleNegative');    addRows(c, 'singleNegative', [P(-1), P(-2)]);          // distinct negatives
    addSession(c, 'overlapsOnly');      addRows(c, 'overlapsOnly', [OV(1), OV(1), OV(1), OV(2, 'vorex'), OV(2, 'vorex')]);   // no primary at all
    addSession(c, 'primaryPlusOverlap'); addRows(c, 'primaryPlusOverlap', [P(4), OV(4), OV(4), OV(4)]);
    addSession(c, 'looseChild');        addRows(c, 'looseChild', [[3, 1, 'arcana'], [3, 1, 'arcana'], P(1)]);   // non-primary repeats, map_index != parent
    addSession(c, 'sameIndexOtherSession'); addRows(c, 'sameIndexOtherSession', [P(1), P(2)]);
    addSession(c, 'dupInTheMiddle');    addRows(c, 'dupInTheMiddle', [P(1), P(2), P(3), P(2), P(4)]);
    addSession(c, 'noRows');
    addSession(c, 'dupBigIndex');       addRows(c, 'dupBigIndex', [P(2 ** 40), P(2 ** 40)]);
    return c;
  }
  const DELETED = ['dupBigIndex', 'dupInTheMiddle', 'dupNegative', 'dupZero', 'triple'];

  it('deletes exactly those sessions (index 0, triples, negatives, huge indexes) and keeps all others', () => {
    const c = build();
    migrate(c);
    expect(version(c)).toBe(5);
    expect(sessionIds(c)).toEqual(['clean', 'looseChild', 'noRows', 'overlapsOnly', 'primaryPlusOverlap', 'sameIndexOtherSession', 'singleNegative']);
    for (const id of DELETED) expect(all(c, 'SELECT 1 FROM session_maps WHERE session_id = ?', id), id).toEqual([]);
  });

  it('every surviving row is byte-identical to its v4 row: id and all columns; session rows identical', () => {
    const c = build();
    const beforeRows = rowsAll(c) as {session_id: string}[];
    const beforeSess = all(c, 'SELECT * FROM sessions ORDER BY id') as {id: string}[];
    const beforeOther = untouched(c);
    migrate(c);
    expect(rowsAll(c)).toEqual(beforeRows.filter(r => !DELETED.includes(r.session_id)));
    expect(all(c, 'SELECT * FROM sessions ORDER BY id')).toEqual(beforeSess.filter(s => !DELETED.includes(s.id)));
    expect(untouched(c)).toEqual(beforeOther);
  });

  it('an overlap row never counts as a duplicate of its primary, nor overlaps of each other; the index still rejects a second primary', () => {
    const c = build();
    migrate(c);
    expect(all(c, "SELECT * FROM session_maps WHERE session_id = 'primaryPlusOverlap'")).toHaveLength(4);
    expect(all(c, "SELECT * FROM session_maps WHERE session_id = 'overlapsOnly'")).toHaveLength(5);
    expect(all(c, "SELECT * FROM session_maps WHERE session_id = 'looseChild'")).toHaveLength(3);
    // an overlaps-only session may gain its primary afterwards, but only one
    addRows(c, 'overlapsOnly', [P(1)]);
    expect(() => addRows(c, 'overlapsOnly', [P(1)])).toThrow(/UNIQUE/);
  });

  it('the log names each deleted session once and reports the exact totals', () => {
    const c = build();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(c);
    const lines = logged(info);
    for (const id of DELETED) expect(lines.filter(l => l.includes(`deleted session ${id} `)), id).toHaveLength(1);
    expect(lines.filter(l => l.includes('deleted session '))).toHaveLength(DELETED.length);
    // dupBigIndex 2 + dupInTheMiddle 5 + dupNegative 2 + dupZero 2 + triple 4
    expect(lines.some(l => l.includes('5 sessions') && l.includes('15 rows'))).toBe(true);
  });
});

describe('v5 with hostile session ids', () => {
  const IDS = ["it's", 'say "hi"', '100%', 'a%', 'a_', 'ab', 'a', '', ' ', ' pad ', '日本語🙂', 'Ünï', 'a\\b', 'x; DROP TABLE sessions; --', 'new\nline'];

  it('dups are found and wiped per exact id: LIKE-wildcards, quotes, unicode, empty and whitespace ids never bleed into neighbours', () => {
    const c = v4Db();
    for (const id of IDS) addSession(c, id);
    for (const id of IDS) addRows(c, id, [P(1), P(2), OV(2)]);
    // dup in just a few of them; their wildcard-neighbours stay
    addRows(c, '100%', [P(1)]);
    addRows(c, 'a_', [P(2)]);
    addRows(c, '', [P(1)]);
    addRows(c, "it's", [P(2)]);
    addRows(c, '日本語🙂', [P(1)]);
    addRows(c, 'x; DROP TABLE sessions; --', [P(2)]);
    const before = rowsAll(c) as {session_id: string}[];
    const dups = ['100%', 'a_', '', "it's", '日本語🙂', 'x; DROP TABLE sessions; --'];
    migrate(c);
    expect(sessionIds(c)).toEqual(IDS.filter(i => !dups.includes(i)).sort());
    expect(rowsAll(c)).toEqual(before.filter(r => !dups.includes(r.session_id)));
    // the survivors have all their rows
    for (const id of ['a%', 'ab', 'a', ' ', ' pad ', 'Ünï', 'say "hi"']) expect(all(c, 'SELECT 1 FROM session_maps WHERE session_id = ?', id), id).toHaveLength(3);
  });

  it('orphans whose id differs only by case, whitespace or unicode normalisation are dropped; the real session is neither deleted nor harmed', () => {
    const c = v4Db();
    addSession(c, 'abc'); addRows(c, 'abc', [P(1), OV(1)]);
    addSession(c, 'é');                         // decomposed e + acute
    addRows(c, 'é', [P(1)]);
    addRows(c, 'ABC', [P(1), P(1)]);                  // orphan dup rows: not a session, so nothing to delete
    addRows(c, 'abc ', [P(1)]);
    addRows(c, ' abc', [P(1)]);
    addRows(c, 'é', [P(1)]);                     // precomposed: a different string
    const keep = all(c, "SELECT * FROM session_maps WHERE session_id IN ('abc', 'é') ORDER BY id");
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    migrate(c);
    expect(rowsAll(c)).toEqual(keep);
    expect(sessionIds(c)).toEqual(['abc', 'é']);
    expect(logged(info).some(l => l.includes('5 orphan rows'))).toBe(true);
    expect(logged(info).some(l => l.includes('0 sessions with duplicated'))).toBe(true);
  });
});

describe('v5 live sessions', () => {
  const quiet = {info: () => {}, warn: () => {}};

  it('a live dup session is wiped; a live clean one is kept with ended_at NULL and every column; crash-close then behaves', () => {
    const c = v4Db();
    addSession(c, 'liveDup', {endedAt: null});     addRows(c, 'liveDup', [P(1), P(1)]);
    addSession(c, 'liveClean', {endedAt: null, savedAt: '2026-10-02T03:04:05.000Z'}); addRows(c, 'liveClean', [P(1), OV(1), P(2)]);
    addSession(c, 'liveEmpty', {endedAt: null, totalTime: 0, dbs: '{}'});
    c.prepare("UPDATE sessions SET drops = '{}', spent = '{}' WHERE id = 'liveEmpty'").run();
    const before = all(c, "SELECT * FROM sessions WHERE id = 'liveClean'");
    migrate(c);
    expect(all(c, "SELECT * FROM sessions WHERE id = 'liveClean'")).toEqual(before);
    expect(sessionIds(c)).toEqual(['liveClean', 'liveEmpty']);

    const store = new SqliteSessionStore(c);
    expect(store.listOpenSessions().map(s => s.id).sort()).toEqual(['liveClean', 'liveEmpty']);
    closeCrashedSessions(store, quiet);
    expect(store.getSession('liveEmpty')).toBeNull();                                           // empty run: deleted
    expect(store.getSession('liveClean')?.endedAt).toBe(Date.parse('2026-10-02T03:04:05.000Z')); // closed at its last write
    expect(store.getRows('liveClean')).toHaveLength(3);
    expect(store.listOpenSessions()).toEqual([]);
  });

  it('crash-closing an empty live session after v5 leaves nothing behind', () => {
    const c = v4Db();
    addSession(c, 'x', {endedAt: null, totalTime: 1});
    c.prepare("UPDATE sessions SET drops = '{}', spent = '{}' WHERE id = 'x'").run();
    migrate(c);
    closeCrashedSessions(new SqliteSessionStore(c), quiet);
    expect(all(c, 'SELECT 1 FROM sessions')).toEqual([]);
    expect(all(c, 'SELECT 1 FROM session_maps')).toEqual([]);
  });
});

describe('v5 AUTOINCREMENT high-water mark', () => {
  function nextId(c: SqlConn, sessionId: string): number {
    return Number(c.prepare('INSERT INTO session_maps (session_id, map_index, started_at, ended_at, duration) VALUES (?, 999, 1, 2, 1)').run(sessionId).lastInsertRowid);
  }

  it('the top rows were deleted long ago (seq > MAX(id)): the next id still exceeds the old seq, one sequence entry only', () => {
    const c = v4Db();
    addSession(c, 'keep'); addRows(c, 'keep', [P(1), P(2)]);
    addSession(c, 'tmp'); addRows(c, 'tmp', [P(1), P(2), P(3)]);
    c.prepare("DELETE FROM session_maps WHERE session_id = 'tmp'").run();
    c.prepare("DELETE FROM sessions WHERE id = 'tmp'").run();
    const seq = seqRows(c)[0].seq;
    expect(seq).toBeGreaterThan(maxId(c)!);
    migrate(c);
    expect(seqRows(c)).toEqual([{name: 'session_maps', seq}]);
    expect(nextId(c, 'keep')).toBe(seq + 1);
  });

  it('the max-id row belonged to a wiped dup session and an orphan holds a higher id: nothing is reused', () => {
    const c = v4Db();
    addSession(c, 'keep'); addRows(c, 'keep', [P(1)]);
    addSession(c, 'dup'); addRows(c, 'dup', [P(1), P(1)]);
    addRows(c, 'ghost', [P(1)]);
    const top = maxId(c)!;
    migrate(c);
    expect(maxId(c)).toBeLessThan(top);
    expect(nextId(c, 'keep')).toBe(top + 1);
  });

  it('an empty session_maps that never had a row (no sqlite_sequence entry) starts at id 1 with exactly one entry', () => {
    const c = v4Db();
    addSession(c, 's');
    expect(seqRows(c)).toEqual([]);
    migrate(c);
    expect(nextId(c, 's')).toBe(1);
    expect(seqRows(c)).toEqual([{name: 'session_maps', seq: 1}]);
  });

  it('an explicitly huge row id survives and the next id follows it', () => {
    const c = v4Db();
    addSession(c, 's');
    c.prepare("INSERT INTO session_maps (id, session_id, map_index, started_at, ended_at, duration) VALUES (?, 's', 1, 1, 2, 1)").run(2 ** 40);
    migrate(c);
    expect(maxId(c)).toBe(2 ** 40);
    expect(nextId(c, 's')).toBe(2 ** 40 + 1);
  });

  it('many sessions and rows migrate and every surviving id is preserved in order', () => {
    const c = v4Db();
    for (let i = 0; i < 60; i++) {
      addSession(c, `s${i}`);
      addRows(c, `s${i}`, i % 7 === 0 ? [P(1), P(1)] : [P(1), OV(1), P(2), OV(2), OV(2)]);
    }
    const before = rowsAll(c) as {id: number; session_id: string}[];
    migrate(c);
    const dupIds = new Set(Array.from({length: 60}, (_, i) => i).filter(i => i % 7 === 0).map(i => `s${i}`));
    expect(rowsAll(c)).toEqual(before.filter(r => !dupIds.has(r.session_id)));
  });
});

describe('v5 attribution backfill edge shapes', () => {
  const CASES: [label: string, dbs: string, expected: 'legacy' | 'exclusive', warns: boolean][] = [
    ['whitespace only',        '   ',                       'legacy',    true],
    ['empty string',           '',                          'legacy',    true],
    ['JSON null',              'null',                      'legacy',    true],
    ['empty array',            '[]',                        'legacy',    false],
    ['array with an element',  '[1]',                       'exclusive', false],
    ['empty-string key',       '{"":{}}',                   'exclusive', false],
    ['empty object',           '{}',                        'legacy',    false],
    ['number',                 '5',                         'legacy',    false],
    ['string',                 '"abc"',                     'exclusive', false],
    ['truncated JSON',         '{"map":{"1":',              'legacy',    true],
    ['padded empty object',    ' \n{ }\t ',                 'legacy',    false],
    ['prototype-ish key',      '{"__proto__":{}}',          'exclusive', false],
  ];

  it("every '' row ends 'legacy' or 'exclusive' by the former rule (zero keys -> legacy), unparsable or null -> legacy with a warning", () => {
    const c = v4Db();
    CASES.forEach(([, dbs], i) => addSession(c, `c${i}`, {attribution: '', dbs}));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    migrate(c);
    CASES.forEach(([label, , expected], i) => expect(c.prepare('SELECT attribution FROM sessions WHERE id = ?').get(`c${i}`), label).toEqual({attribution: expected}));
    expect(all(c, "SELECT 1 FROM sessions WHERE attribution = ''")).toEqual([]);
    const warned = logged(warn);
    CASES.forEach(([label, , , w], i) => expect(warned.some(l => l.includes(`session c${i}:`)), label).toBe(w));
  });

  it('a very large drops_by_source (20k keys) -> exclusive; a 500 KB padded empty object -> legacy', () => {
    const c = v4Db();
    const big = JSON.stringify(Object.fromEntries(Array.from({length: 20_000}, (_, i) => [`k${i}`, {[i]: i}])));
    addSession(c, 'big', {attribution: '', dbs: big});
    addSession(c, 'padded', {attribution: '', dbs: ' '.repeat(500_000) + '{}'});
    migrate(c);
    expect(c.prepare("SELECT attribution FROM sessions WHERE id = 'big'").get()).toEqual({attribution: 'exclusive'});
    expect(c.prepare("SELECT attribution FROM sessions WHERE id = 'padded'").get()).toEqual({attribution: 'legacy'});
  });

  it("stored values are never touched, whatever drops_by_source holds: 'drop-through' with '' dbs, odd stored strings, case variants", () => {
    const c = v4Db();
    const stored = ['drop-through', 'legacy', 'exclusive', ' ', 'Legacy', 'EXCLUSIVE', 'garbage', '日本'];
    stored.forEach((a, i) => addSession(c, `t${i}`, {attribution: a, dbs: i % 2 ? '' : '{}'}));
    const before = all(c, 'SELECT * FROM sessions ORDER BY id');
    migrate(c);
    expect(all(c, 'SELECT * FROM sessions ORDER BY id')).toEqual(before);
  });

  it('only attribution changes on a backfilled row: every other column is byte-identical', () => {
    const c = v4Db();
    addSession(c, 'b', {attribution: '', dbs: '{"map":{"1":1}}', endedAt: null});
    const before = c.prepare("SELECT * FROM sessions WHERE id = 'b'").get() as Record<string, unknown>;
    migrate(c);
    expect(c.prepare("SELECT * FROM sessions WHERE id = 'b'").get()).toEqual({...before, attribution: 'exclusive'});
  });

  it("a dup session with attribution '' is deleted, never backfilled (no warning even for unparsable data)", () => {
    const c = v4Db();
    addSession(c, 'dupBad', {attribution: '', dbs: 'not json'}); addRows(c, 'dupBad', [P(1), P(1)]);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    migrate(c);
    expect(sessionIds(c)).toEqual([]);
    expect(logged(warn).filter(l => l.includes('unparsable'))).toEqual([]);
  });
});

describe('v5 idempotence', () => {
  function populated(): SqlConn {
    const c = v4Db();
    addSession(c, 'a', {attribution: ''}); addRows(c, 'a', [P(1), OV(1), P(2)]);
    addSession(c, 'dup'); addRows(c, 'dup', [P(1), P(1)]);
    addRows(c, 'ghost', [P(1)]);
    return c;
  }
  const snapshot = (c: SqlConn) => ({
    master: all(c, 'SELECT type, name, sql FROM sqlite_master ORDER BY type, name'),
    sessions: all(c, 'SELECT * FROM sessions ORDER BY id'), rows: rowsAll(c), seq: seqRows(c),
    other: untouched(c), v: version(c),
  });

  it('a second runMigrations changes nothing at all (schema, rows, sequence) and warns about nothing', () => {
    const c = populated();
    migrate(c);
    const once = snapshot(c);
    const warn = vi.spyOn(log, 'warn');
    migrate(c);
    expect(snapshot(c)).toEqual(once);
    expect(warn).not.toHaveBeenCalled();
  });

  it('re-running the v5 up() itself on a v5 DB is data-neutral (wipes nothing, reuses no id, keeps the schema)', () => {
    const c = populated();
    migrate(c);
    const once = snapshot(c);
    c.setPragma('foreign_keys', 'OFF');
    c.transaction(() => MIGRATIONS[4].up(c));
    c.setPragma('foreign_keys', 'ON');
    expect(snapshot(c)).toEqual(once);
    expect(c.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('v5 atomicity: a failure at any point leaves the v4 DB exactly as it was', () => {
  function seeded(): SqlConn {
    const c = v4Db();
    addSession(c, 'keep', {attribution: ''}); addRows(c, 'keep', [P(1), OV(1)]);
    addSession(c, 'dup'); addRows(c, 'dup', [P(1), P(1)]);
    addRows(c, 'ghost', [P(1)]);
    c.exec("INSERT INTO seasonal_stats (zone_type, zone_count) VALUES ('sandlord', 3)");
    c.exec("INSERT INTO wealth_datapoints (timestamp, value, session_id) VALUES (1, 2, 'dup'), (3, 4, 'ghost')");
    return c;
  }
  const full = (c: SqlConn) => ({
    master:     all(c, 'SELECT type, name, sql FROM sqlite_master ORDER BY type, name'),
    sessions:   all(c, 'SELECT * FROM sessions ORDER BY id'),
    rows:       rowsAll(c),
    seasonal:   all(c, 'SELECT * FROM seasonal_stats'),
    wealth:     all(c, 'SELECT * FROM wealth_datapoints ORDER BY id'),
    wealthCols: all<{name: string}>(c, 'PRAGMA table_info(wealth_datapoints)').map(x => x.name),
    seq:        seqRows(c),
    other:      untouched(c),
    v:          version(c),
    fk:         c.getPragma('foreign_keys'),
  });

  /** A conn whose exec/prepare throws once the SQL matches: a failure part-way through the step. */
  function failingAt(c: SqlConn, re: RegExp): SqlConn {
    return {
      ...c,
      exec:    (sql: string) => { if (re.test(sql)) throw new Error('boom'); return c.exec(sql); },
      prepare: ((sql: string) => { if (re.test(sql)) throw new Error('boom'); return c.prepare(sql); }) as SqlConn['prepare'],
    };
  }

  it.each([
    ['after the whole step',                                 null],
    ['after the rebuild, before seasonal_stats is dropped',  /DROP TABLE IF EXISTS seasonal_stats/],
    ['at the attribution UPDATE',                            /UPDATE sessions SET attribution/],
    ['at the wealth column drop',                            /DROP COLUMN session_id/],
    ['at the very first delete',                             /DELETE FROM session_maps WHERE session_id = \?/],
    ['at the table rebuild',                                 /CREATE TABLE session_maps_new/],
  ] as [string, RegExp | null][])('%s: dup sessions, seasonal_stats, wealth.session_id, sequence, user_version 4 and foreign_keys ON all come back', (_label, re) => {
    const c = seeded();
    const before = full(c);
    const steps = re === null
      ? [...UP_TO_V4, {...MIGRATIONS[4], up: (x: SqlConn) => { MIGRATIONS[4].up(x); throw new Error('boom'); }}]
      : [...UP_TO_V4, {...MIGRATIONS[4], up: (x: SqlConn) => MIGRATIONS[4].up(failingAt(x, re))}];
    expect(() => runMigrations(c, steps, {backup: () => {}})).toThrow('boom');
    expect(full(c)).toEqual(before);
    expect(before.v).toBe(4);
    expect(before.wealthCols).toContain('session_id');
    expect(before.seasonal).toHaveLength(1);

    // a retry with the real step succeeds on the very same connection
    migrate(c);
    expect(version(c)).toBe(5);
    expect(sessionIds(c)).toEqual(['keep']);
    expect(c.getPragma('foreign_keys')).toBe(1);
  });
});

describe('v5 schema after the run', () => {
  it('the FK refuses orphan inserts for any odd id (case, padding, empty, wildcard) and a bulk session delete cascades everything', () => {
    const c = v4Db();
    addSession(c, 'a'); addRows(c, 'a', [P(1)]);
    addSession(c, 'b'); addRows(c, 'b', [P(1)]);
    migrate(c);
    for (const id of ['A', 'a ', '', '%', 'nope']) expect(() => addRows(c, id, [P(7)]), JSON.stringify(id)).toThrow(/FOREIGN KEY/);
    c.prepare('DELETE FROM sessions').run();
    expect(rowsAll(c)).toEqual([]);
  });

  it('a unique-index collision never half-applies a multi-row insert', () => {
    const c = v4Db();
    addSession(c, 'a'); addRows(c, 'a', [P(1)]);
    migrate(c);
    const store = new SqliteSessionStore(c);
    const row = (mapIndex: number, parent: number | null = null) => ({
      sessionId: 'a', mapIndex, startedAt: 1, endedAt: 2, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: parent, phase: null,
    });
    expect(() => store.insertRows([row(2), row(3), row(1)])).toThrow(/UNIQUE/);
    expect(store.getRows('a').map(r => r.mapIndex)).toEqual([1]);
    expect(store.maxPrimaryMapIndex('a')).toBe(1);
  });
});
