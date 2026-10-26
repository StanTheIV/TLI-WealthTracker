/**
 * Step 1.2 (test-first) — migration v2 `cost-on-map`.
 *
 * Expected from the implementation (absent today):
 *   - `MIGRATIONS[1] = {version: 2, name: 'cost-on-map', backup: 'pre-cost-migration', up}`
 *     in src/main/db/migrations.ts; `up` adds `sessions.spent TEXT NOT NULL DEFAULT '{}'`.
 *   - `migrateSessionCost` exported from `src/main/db/migrations/cost-v2.ts` (pure, no DB):
 *       migrateSessionCost(
 *         session: {drops, dropsBySource, attribution},
 *         rows:    {id, drops, spent, isPrimary}[],
 *       ) => {session: {drops, dropsBySource, spent}, rows: {id, drops, spent}[], stats}
 *     `rows` lists the CHANGED rows only; all maps are string-keyed Record<string, number>;
 *     the shape of `stats` is not pinned here.
 *
 * Both layers use ONE fixture (FIXTURE below). Every expected value is
 * hand-computed in the comments next to it. Row rule: for a primary row with a
 * non-empty `spent`, if some spent id is not an OWN key of its `drops` the row
 * is stale (`spent` -> {}, drops untouched); otherwise `drops[id] += spent[id]`
 * (zero results deleted) and `spent` is kept. Overlap rows never change.
 * Session rule: `drops[id] += tot[id]` (tot = Σ non-stale primary spent);
 * `dropsBySource` (when non-empty) restores each id's negatives where they sit:
 * `map` bucket first, then the other buckets, each up to its negative's
 * magnitude, remainder into `map`, zeros deleted; `spent` = Σ rows' final spent.
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

// ---------------------------------------------------------------------------
// Module under test, loaded dynamically so this file typechecks before it exists
// ---------------------------------------------------------------------------

type Nums = Record<string, number>;
type HelperRow = {id: number; drops: Nums; spent: Nums; isPrimary: boolean};
type HelperSession = {drops: Nums; dropsBySource: Record<string, Nums>; attribution: string};
type HelperOut = {
  session: {drops: Nums; dropsBySource: Record<string, Nums>; spent: Nums};
  rows:    Array<{id: number; drops: Nums; spent: Nums}>;
  stats:   unknown;
};
type MigrateSessionCost = (session: HelperSession, rows: HelperRow[]) => HelperOut;

const COST_V2_MODULE = '@/main/db/migrations/cost-v2';

async function loadHelper(): Promise<MigrateSessionCost> {
  let mod: {migrateSessionCost?: MigrateSessionCost};
  try {
    mod = await import(/* @vite-ignore */ COST_V2_MODULE);
  } catch (err) {
    throw new Error(`module ${COST_V2_MODULE} is missing: ${(err as Error).message}`);
  }
  if (typeof mod.migrateSessionCost !== 'function') throw new Error('cost-v2 must export migrateSessionCost');
  return mod.migrateSessionCost;
}

// ---------------------------------------------------------------------------
// Fixture: every case the brief lists. JSON text keeps own `__proto__` keys.
// ---------------------------------------------------------------------------

interface FxRow {
  id:        number;           // session_maps.id (insertion order across ALL sessions)
  mapIndex:  number;
  seasonal:  string | null;
  parent:    number | null;    // parent_map_index; null = primary
  drops:     string;           // raw JSON text as stored
  spent:     string;
  /** Expected after v2; null = row must not be rewritten at all (raw text identical). */
  after:     {drops: string; spent: string} | null;
}
interface FxSession {
  id:          string;
  attribution: string;
  drops:       string;
  dbs:         string;
  rows:        FxRow[];
  after:       {drops: string; dbs: string; spent: string};
}

const FIXTURE: FxSession[] = [
  {
    // ---- 'main': drop-through; normal / stale / interlude / overlap / standalone-stale; a negative in a seasonal bucket
    id: 'main', attribution: 'drop-through',
    // Σ drops: 100: R1 -3 + R3 -2 = -5 | 101: -1 | 102: 0 | 103: 2 | 104: R2 -5 | 200: R1 7 + R2 1 = 8 | 300: R5 4
    drops: '{"100":-5,"101":-1,"102":0,"103":2,"104":-5,"200":8,"300":4}',
    // 100: -2 in map (interlude R3) + -3 in sandlord (entry cost booked to a live seasonal); sums to -5
    dbs:   '{"map":{"100":-2,"101":-1,"102":0,"103":2,"104":-5,"200":8},"sandlord":{"100":-3,"300":4}}',
    rows: [
      {
        // R1 normal. 100 exact (drops = -spent), 101 partial (-1 > -3), 102 zero (key present, value 0),
        // 103 looted more than spent (+2), 200 unrelated loot.
        id: 1, mapIndex: 1, seasonal: null, parent: null,
        drops: '{"100":-3,"101":-1,"102":0,"103":2,"200":7}',
        spent: '{"100":3,"101":3,"102":3,"103":3}',
        // 100: -3+3 = 0 -> deleted | 101: -1+3 = 2 | 102: 0+3 = 3 | 103: 2+3 = 5 | 200 untouched 7 | spent kept
        after: {drops: '{"101":2,"102":3,"103":5,"200":7}', spent: '{"100":3,"101":3,"102":3,"103":3}'},
      },
      {
        // R2 stale: id 100 is absent from drops (basket never credited; copy of the previous row's spent).
        // The present id 104 must NOT be restored — the whole row is cleared.
        id: 2, mapIndex: 2, seasonal: null, parent: null,
        drops: '{"104":-5,"200":1}',
        spent: '{"100":3,"104":5}',
        after: {drops: '{"104":-5,"200":1}', spent: '{}'},
      },
      {
        // R3 interlude map row: spent {} with the cost only as a negative drop. Left alone (raw text unchanged).
        id: 3, mapIndex: 3, seasonal: null, parent: null,
        drops: '{ "100": -2 }',
        spent: '{}',
        after: null,
      },
      {
        // R4 overlap of R1: never touched.
        id: 4, mapIndex: 1, seasonal: 'overrealm', parent: 1,
        drops: '{ "200": 2 }',
        spent: '{}',
        after: null,
      },
      {
        // R5 standalone seasonal, stale copy of R2's basket (300 present, 100 absent).
        id: 5, mapIndex: 4, seasonal: 'sandlord', parent: null,
        drops: '{"300":4}',
        spent: '{"100":3}',
        after: {drops: '{"300":4}', spent: '{}'},
      },
    ],
    // tot = R1 only (R2/R5 stale, R3/R4 spent {}) = {100:3,101:3,102:3,103:3}
    // drops: 100: -5+3 = -2 | 101: -1+3 = 2 | 102: 0+3 = 3 | 103: 2+3 = 5 | 104 -5 | 200 8 | 300 4
    // dbs, id 100 (tot 3): map -2 -> +2 = 0 deleted, left 1; sandlord -3 -> +1 = -2
    //      id 101 (3): map -1 -> +1 = 0, left 2 -> no other negative -> map 0+2 = 2
    //      id 102 (3): map 0 is not a negative -> remainder 3 into map = 3
    //      id 103 (3): map 2 is not a negative -> remainder 3 into map = 5
    after: {
      drops: '{"100":-2,"101":2,"102":3,"103":5,"104":-5,"200":8,"300":4}',
      dbs:   '{"map":{"101":2,"102":3,"103":5,"104":-5,"200":8},"sandlord":{"100":-2,"300":4}}',
      spent: '{"100":3,"101":3,"102":3,"103":3}',
    },
  },
  {
    // ---- 'cont': a continued session — duplicate primary mapIndex 1 (run 2 restarted at 1); both migrate
    id: 'cont', attribution: 'drop-through',
    drops: '{"100":-6,"200":4}',                 // -2 + -4 ; 1 + 3
    dbs:   '{"map":{"100":-6,"200":4}}',
    rows: [
      {id: 6, mapIndex: 1, seasonal: null, parent: null, drops: '{"100":-2,"200":1}', spent: '{"100":2}',
       after: {drops: '{"200":1}', spent: '{"100":2}'}},                       // -2+2 = 0 deleted
      {id: 7, mapIndex: 1, seasonal: null, parent: null, drops: '{"100":-4,"200":3}', spent: '{"100":4}',
       after: {drops: '{"200":3}', spent: '{"100":4}'}},                       // -4+4 = 0 deleted
    ],
    // tot 100 = 2+4 = 6 ; session 100: -6+6 = 0 deleted ; map bucket 100: -6 +6 = 0 deleted
    after: {drops: '{"200":4}', dbs: '{"map":{"200":4}}', spent: '{"100":6}'},
  },
  {
    // ---- 'excl': attribution '' (inferred exclusive); the overlap's drops live in their own bucket
    id: 'excl', attribution: '',
    drops: '{"100":-2,"200":5,"400":1}',
    dbs:   '{"map":{"100":-2,"200":5},"arcana":{"400":1}}',
    rows: [
      {id: 8, mapIndex: 1, seasonal: null, parent: null, drops: '{"100":-2,"200":5}', spent: '{"100":2}',
       after: {drops: '{"200":5}', spent: '{"100":2}'}},                        // -2+2 = 0 deleted
      {id: 9, mapIndex: 1, seasonal: 'arcana', parent: 1, drops: '{"400":1}', spent: '{}', after: null},
    ],
    // session 100: -2+2 = 0 deleted ; map bucket 100: -2 +2 = 0 deleted ; arcana bucket untouched
    after: {drops: '{"200":5,"400":1}', dbs: '{"map":{"200":5},"arcana":{"400":1}}', spent: '{"100":2}'},
  },
  {
    // ---- 'hub': a legitimate standalone seasonal row (town -> hub entry cost, booked to the seasonal writer)
    id: 'hub', attribution: 'drop-through',
    drops: '{"100":-3,"300":4}',
    dbs:   '{"sandlord":{"100":-3,"300":4}}',
    rows: [
      {id: 10, mapIndex: 1, seasonal: 'sandlord', parent: null, drops: '{"100":-3,"300":4}', spent: '{"100":3}',
       after: {drops: '{"300":4}', spent: '{"100":3}'}},                        // -3+3 = 0 deleted
    ],
    // no map bucket: id 100's negative sits in sandlord -> -3+3 = 0 deleted
    after: {drops: '{"300":4}', dbs: '{"sandlord":{"300":4}}', spent: '{"100":3}'},
  },
  {
    // ---- 'proto': ids that collide with Object.prototype members
    id: 'proto', attribution: 'drop-through',
    drops: '{"__proto__":-3,"constructor":-1,"100":6}',
    dbs:   '{"map":{"__proto__":-3,"constructor":-1,"100":6}}',
    rows: [
      {
        id: 11, mapIndex: 1, seasonal: null, parent: null,
        drops: '{"__proto__":-3,"constructor":-1,"100":5}',
        spent: '{"__proto__":3,"constructor":3}',
        // __proto__: -3+3 = 0 deleted | constructor: -1+3 = 2 | 100 untouched 5
        after: {drops: '{"constructor":2,"100":5}', spent: '{"__proto__":3,"constructor":3}'},
      },
      {
        // 'toString' exists on Object.prototype but is NOT an own key of drops -> stale
        id: 12, mapIndex: 2, seasonal: null, parent: null,
        drops: '{"100":1}',
        spent: '{"toString":1}',
        after: {drops: '{"100":1}', spent: '{}'},
      },
    ],
    // tot = {__proto__:3, constructor:3}; session: __proto__ -3+3 = 0 deleted | constructor -1+3 = 2 | 100: 6
    // map bucket: __proto__ -3 +3 = 0 deleted | constructor -1 +1 = 0 deleted, left 2 -> map 0+2 = 2 | 100: 6
    after: {drops: '{"constructor":2,"100":6}', dbs: '{"map":{"constructor":2,"100":6}}', spent: '{"__proto__":3,"constructor":3}'},
  },
  {
    // ---- 'legacy': empty dropsBySource stays empty (no map bucket is invented)
    id: 'legacy', attribution: '',
    drops: '{"100":-2,"200":3}',
    dbs:   '{}',
    rows: [
      {id: 13, mapIndex: 1, seasonal: null, parent: null, drops: '{"100":-2,"200":3}', spent: '{"100":2}',
       after: {drops: '{"200":3}', spent: '{"100":2}'}},                        // -2+2 = 0 deleted
    ],
    after: {drops: '{"200":3}', dbs: '{}', spent: '{"100":2}'},
  },
  {
    // ---- 'none': nothing to migrate; raw text must not even be rewritten
    id: 'none', attribution: 'drop-through',
    drops: '{ "200": 1 }',
    dbs:   '{ "map": { "200": 1 } }',
    rows: [
      {id: 14, mapIndex: 1, seasonal: null, parent: null, drops: '{ "200": 1 }', spent: '{}', after: null},
    ],
    after: {drops: '{ "200": 1 }', dbs: '{ "map": { "200": 1 } }', spent: '{}'},
  },
];

const parse = (text: string): Nums => JSON.parse(text);
/** Own entries, order-insensitive — compares objects holding an own `__proto__` key safely. */
const entries = (o: unknown): Array<[string, unknown]> =>
  Object.entries(o as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) =>
    [k, v !== null && typeof v === 'object' ? entries(v) : v]);
const same = (actual: unknown, expectedJson: string) => expect(entries(actual)).toEqual(entries(JSON.parse(expectedJson)));

const asHelperInput = (s: FxSession): [HelperSession, HelperRow[]] => [
  {drops: parse(s.drops), dropsBySource: JSON.parse(s.dbs), attribution: s.attribution},
  s.rows.map(r => ({id: r.id, drops: parse(r.drops), spent: parse(r.spent), isPrimary: r.parent === null})),
];

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe('migrateSessionCost (pure)', () => {
  it.each(FIXTURE.map(s => [s.id, s] as const))('session %s: row-by-row and session-level result', async (_id, s) => {
    const migrate = await loadHelper();
    const out = migrate(...asHelperInput(s));

    const changedRows = s.rows.filter(r => r.after !== null);
    expect(out.rows.map(r => r.id).sort((a, b) => a - b)).toEqual(changedRows.map(r => r.id));
    for (const r of changedRows) {
      const got = out.rows.find(o => o.id === r.id)!;
      same(got.drops, r.after!.drops);
      same(got.spent, r.after!.spent);
    }
    same(out.session.drops, s.after.drops);
    same(out.session.dropsBySource, s.after.dbs);
    same(out.session.spent, s.after.spent);
  });

  it('does not mutate its inputs', async () => {
    const migrate = await loadHelper();
    const [session, rows] = asHelperInput(FIXTURE[0]);
    const before = structuredClone([session, rows]);
    migrate(session, rows);
    expect([session, rows]).toEqual(before);
  });

  it('an overlap row is never touched or counted, even with a non-empty spent', async () => {
    const migrate = await loadHelper();
    const out = migrate(
      {drops: {'100': -2, '200': 1}, dropsBySource: {}, attribution: 'drop-through'},
      [{id: 1, drops: {'100': -2, '200': 1}, spent: {'100': 2}, isPrimary: false}],
    );
    expect(out.rows).toEqual([]);
    expect(out.session.drops).toEqual({'100': -2, '200': 1});   // tot stays empty: nothing added back
  });

  it('a stale row (some spent id absent from drops) does not add to the session either', async () => {
    const migrate = await loadHelper();
    const out = migrate(
      {drops: {'104': -5}, dropsBySource: {map: {'104': -5}}, attribution: 'drop-through'},
      [{id: 1, drops: {'104': -5}, spent: {'100': 3, '104': 5}, isPrimary: true}],
    );
    expect(out.rows).toEqual([{id: 1, drops: {'104': -5}, spent: {}}]);
    expect(out.session.drops).toEqual({'104': -5});
    expect(out.session.dropsBySource).toEqual({map: {'104': -5}});
    expect(out.session.spent).toEqual({});
  });

  it('a zero-valued own key is present, not absent (the row is migrated, not stale)', async () => {
    const migrate = await loadHelper();
    const out = migrate(
      {drops: {'102': 0}, dropsBySource: {}, attribution: 'drop-through'},
      [{id: 1, drops: {'102': 0}, spent: {'102': 3}, isPrimary: true}],
    );
    expect(out.rows).toEqual([{id: 1, drops: {'102': 3}, spent: {'102': 3}}]);
    expect(out.session.drops).toEqual({'102': 3});
  });
});

// ---------------------------------------------------------------------------
// Through the migration runner
// ---------------------------------------------------------------------------

const conns: SqlConn[] = [];
afterEach(() => { while (conns.length) conns.pop()!.close(); });

function open(): SqlConn {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  conns.push(conn);
  return conn;
}

/** A DB exactly as v1 left it: V1 schema, user_version `version`, then the fixture as raw INSERTs. */
function seededDb(version: 0 | 1, sessions: FxSession[] = FIXTURE): SqlConn {
  const conn = open();
  MIGRATIONS[0].up(conn);
  conn.setPragma('user_version', version);
  for (const s of sessions) {
    conn.prepare(`INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops, drops_by_source, attribution, price_snapshot)
                  VALUES (?, ?, '2026-10-01T00:00:00.000Z', 60, 50, 1, ?, ?, ?, '{"100":1.5}')`)
      .run(s.id, `name-${s.id}`, s.drops, s.dbs, s.attribution);
    for (const r of s.rows) {
      conn.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
                    VALUES (?, ?, 1000, 2000, ?, ?, ?, ?, NULL)`)
        .run(s.id, r.mapIndex, r.drops, r.spent, r.seasonal, r.parent);
    }
  }
  return conn;
}

const version = (c: SqlConn) => Number(c.getPragma('user_version'));
const rawRows = (c: SqlConn) => c.prepare('SELECT id, drops, spent FROM session_maps ORDER BY id').all<{id: number; drops: string; spent: string}>();
const rawSessions = (c: SqlConn) => c.prepare('SELECT * FROM sessions ORDER BY id').all();
const migrate = (c: SqlConn, backup: (r: string) => void = () => {}) => runMigrations(c, MIGRATIONS, {backup});

describe('MIGRATIONS[1]', () => {
  it('is v2 cost-on-map with the pre-cost-migration backup', () => {
    expect(MIGRATIONS[1]).toMatchObject({version: 2, name: 'cost-on-map', backup: 'pre-cost-migration'});
  });
});

describe('v1 -> v2 on the fixture', () => {
  it('adds sessions.spent and bumps user_version to 2', () => {
    const conn = seededDb(1);
    migrate(conn);
    expect(version(conn)).toBe(2);
    const col = conn.prepare('PRAGMA table_info(sessions)').all<{name: string; notnull: number; dflt_value: string | null}>()
      .find(c => c.name === 'spent');
    expect(col).toMatchObject({notnull: 1, dflt_value: "'{}'"});
  });

  it.each(FIXTURE.map(s => [s.id, s] as const))('session %s: every row and the session record', (_id, s) => {
    const conn  = seededDb(1);
    migrate(conn);
    const store = new SqliteSessionStore(conn);

    const rows = store.getRows(s.id);
    expect(rows).toHaveLength(s.rows.length);
    s.rows.forEach((fx, i) => {
      const got = rows[i];
      same(got.drops, (fx.after ?? fx).drops);
      same(got.spent, (fx.after ?? fx).spent);
      expect(got).toMatchObject({mapIndex: fx.mapIndex, seasonalType: fx.seasonal, parentMapIndex: fx.parent});
    });

    const session = store.getSession(s.id)! as unknown as {drops: Nums; dropsBySource: Record<string, Nums>; spent: Nums; priceSnapshot: Nums; name: string};
    same(session.drops, s.after.drops);
    same(session.dropsBySource, s.after.dbs);
    same(session.spent, s.after.spent);
    expect(session.priceSnapshot).toEqual({'100': 1.5});   // unrelated columns untouched
    expect(session.name).toBe(`name-${s.id}`);
  });

  it('rewrites only what changed: untouched rows and sessions keep their exact raw text', () => {
    const conn   = seededDb(1);
    const before = rawRows(conn);
    migrate(conn);
    const after  = rawRows(conn);

    for (const s of FIXTURE) for (const fx of s.rows) {
      if (fx.after === null) expect(after.find(r => r.id === fx.id)).toEqual(before.find(r => r.id === fx.id));
    }
    const none = conn.prepare("SELECT drops, drops_by_source, spent FROM sessions WHERE id = 'none'").get<{drops: string; drops_by_source: string; spent: string}>();
    expect(none).toEqual({drops: '{ "200": 1 }', drops_by_source: '{ "map": { "200": 1 } }', spent: '{}'});
  });

  it('asks for exactly one backup, pre-cost-migration', () => {
    const backup = vi.fn();
    migrate(seededDb(1), backup);
    expect(backup.mock.calls).toEqual([['pre-cost-migration']]);
  });

  it('a second run is a no-op: no backup, version 2, identical data', () => {
    const conn = seededDb(1);
    migrate(conn);
    const sessions = rawSessions(conn);
    const rows     = rawRows(conn);

    const backup = vi.fn();
    migrate(conn, backup);

    expect(backup).not.toHaveBeenCalled();
    expect(version(conn)).toBe(2);
    expect(rawSessions(conn)).toEqual(sessions);
    expect(rawRows(conn)).toEqual(rows);
  });
});

describe('v0 and fresh databases', () => {
  it('a v0 DB with data runs v1 + v2 in one run with ONE backup (pre-versioned-migrations)', () => {
    const conn   = seededDb(0);
    const backup = vi.fn();
    migrate(conn, backup);

    expect(backup.mock.calls).toEqual([['pre-versioned-migrations']]);
    expect(version(conn)).toBe(2);
    const store = new SqliteSessionStore(conn);
    same(store.getRows('main')[0].drops, '{"101":2,"102":3,"103":5,"200":7}');
    same((store.getSession('main') as unknown as {spent: Nums}).spent, FIXTURE[0].after.spent);
  });

  it('a fresh DB gets the spent column, no backup, empty data', () => {
    const conn   = open();
    const backup = vi.fn();
    migrate(conn, backup);

    expect(backup).not.toHaveBeenCalled();
    expect(version(conn)).toBe(2);
    expect(conn.prepare('PRAGMA table_info(sessions)').all<{name: string}>().map(c => c.name)).toContain('spent');
    expect(rawSessions(conn)).toEqual([]);
  });
});

describe('failure', () => {
  it('a malformed JSON row rolls the whole step back and leaves the DB at v1', () => {
    const conn = seededDb(1);
    // Sorts after the fixture sessions, so earlier sessions were already migrated in-flight when it fails.
    conn.prepare(`INSERT INTO sessions (id, name, saved_at, drops, drops_by_source, attribution) VALUES ('zz-bad', 'bad', 'x', '{}', '{}', 'drop-through')`).run();
    conn.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent) VALUES ('zz-bad', 1, 1, 1, '{not json', '{"100":1}')`).run();
    const sessions = rawSessions(conn);
    const rows     = rawRows(conn);

    expect(() => migrate(conn)).toThrow();

    expect(version(conn)).toBe(1);
    expect(conn.prepare('PRAGMA table_info(sessions)').all<{name: string}>().map(c => c.name)).not.toContain('spent');
    expect(rawSessions(conn)).toEqual(sessions);
    expect(rawRows(conn)).toEqual(rows);
  });
});
