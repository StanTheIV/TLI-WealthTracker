/**
 * Step 1.2 adversarial — migration v2 `cost-on-map`.
 *
 * Seeded randomized property tests over `migrateSessionCost`, hand-picked edge
 * cases, and `MIGRATIONS[1].up` over a v1 DB with many sessions.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import {migrateSessionCost, type CostRowIn, type CostSessionIn, type Counts} from '@/main/db/migrations/cost-v2';
import type {SqlConn} from '@/main/db/sql-conn';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** mulberry32 — fixed-seed PRNG, no dependency. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ['100', '101', '102', '103', '200', '__proto__', 'constructor'];
const SOURCES = ['map', 'sandlord', 'arcana', 'vorex'];

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const mk  = (entries: Array<[string, number]>): Counts => Object.fromEntries(entries);
const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);
/** Key-order independent canonical form (own keys, incl. `__proto__`). */
const canon = (o: Counts): string => JSON.stringify(Object.entries(o).sort(byKey));
const canonBy = (d: Record<string, Counts>): string =>
  JSON.stringify(Object.entries(d).sort(byKey).map(([k, v]) => [k, canon(v)]));
const get = (o: Counts, k: string): number => (own(o, k) ? o[k] : 0);
const add = (o: Counts, k: string, q: number): void => {
  Object.defineProperty(o, k, {value: get(o, k) + q, enumerable: true, writable: true, configurable: true});
};

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

function shuffleKeys(rand: () => number, o: Counts): Counts {
  const e = Object.entries(o).map(x => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  return Object.fromEntries(e);
}

interface Gen {session: CostSessionIn; rows: CostRowIn[]}

function gen(rand: () => number): Gen {
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]) => xs[int(0, xs.length - 1)];
  const subset = (xs: readonly string[], p: number) => xs.filter(() => rand() < p);

  const rows: CostRowIn[] = [];
  const nRows = int(0, 7);
  for (let i = 0; i < nRows; i++) {
    const drops = mk(subset(IDS, 0.5).map(id => [id, int(-6, 6)]));
    const isPrimary = rand() < 0.75;
    let spentIds: string[];
    const r = rand();
    if (r < 0.2)      spentIds = [];
    else if (r < 0.7) spentIds = Object.keys(drops).filter(() => rand() < 0.8);     // non-stale (or empty)
    else              spentIds = subset(IDS, 0.4);                                    // maybe stale
    rows.push({id: i + 1, drops, spent: mk(spentIds.map(id => [id, int(1, 9)])), isPrimary});
  }

  const sum = new Map<string, number>();
  for (const r of rows) for (const [k, v] of Object.entries(r.drops)) sum.set(k, (sum.get(k) ?? 0) + v);
  const drops = Object.fromEntries(sum);

  let dropsBySource: Record<string, Counts> = {};
  if (rand() < 0.7) {
    const srcs = subset(SOURCES, 0.6);
    if (srcs.length === 0) srcs.push(pick(SOURCES));
    dropsBySource = Object.fromEntries(srcs.map(s => [s, mk(subset(IDS, 0.5).map(id => [id, int(-8, 8)]))]));
  }
  return {session: {drops, dropsBySource, attribution: 'drop-through'}, rows};
}

const sumBuckets = (d: Record<string, Counts>, id: string) => Object.values(d).reduce((a, b) => a + get(b, id), 0);

// ---------------------------------------------------------------------------
// properties
// ---------------------------------------------------------------------------

describe('migrateSessionCost — randomized properties (fixed seeds)', () => {
  const N = 1500;

  it('row rule: non-stale rows gain exactly spent (zeros deleted), stale rows only lose spent, the rest is not rewritten', () => {
    const rand = rng(0x12C057);
    for (let n = 0; n < N; n++) {
      const g = deepFreeze(gen(rand));
      const out = migrateSessionCost(g.session, g.rows);

      const expectChanged = g.rows.filter(r => r.isPrimary && Object.keys(r.spent).length > 0);
      expect(out.rows.map(r => r.id), `case ${n}`).toEqual(expectChanged.map(r => r.id));

      for (const r of expectChanged) {
        const o = out.rows.find(x => x.id === r.id)!;
        const stale = Object.keys(r.spent).some(id => !own(r.drops, id));
        if (stale) {
          expect(canon(o.drops), `case ${n} stale drops`).toBe(canon(r.drops));
          expect(o.spent).toEqual({});
          continue;
        }
        expect(canon(o.spent), `case ${n} spent kept`).toBe(canon(r.spent));
        const ids = new Set([...Object.keys(r.drops), ...Object.keys(r.spent)]);
        for (const id of ids) {
          const want = get(r.drops, id) + get(r.spent, id);
          expect(get(o.drops, id), `case ${n} id ${id}`).toBe(want);
          // only keys the addition lands on 0 are deleted
          if (own(r.spent, id)) expect(own(o.drops, id)).toBe(want !== 0);
          else                  expect(own(o.drops, id)).toBe(own(r.drops, id));
        }
        expect(Object.keys(o.drops).every(k => ids.has(k))).toBe(true);
      }
    }
  });

  it('session rule: drops, spent and dropsBySource totals are conserved against the migrated rows', () => {
    const rand = rng(0x5E5510);
    for (let n = 0; n < N; n++) {
      const g = deepFreeze(gen(rand));
      const out = migrateSessionCost(g.session, g.rows);

      // Σ of the non-stale primary rows' spent
      const tot: Counts = {};
      for (const r of g.rows) {
        if (!r.isPrimary || Object.keys(r.spent).length === 0) continue;
        if (Object.keys(r.spent).some(id => !own(r.drops, id))) continue;
        for (const [id, q] of Object.entries(r.spent)) add(tot, id, q);
      }
      const migratedSpent: Counts = {};
      for (const r of out.rows) for (const [id, q] of Object.entries(r.spent)) add(migratedSpent, id, q);
      expect(canon(out.session.spent), `case ${n}`).toBe(canon(tot));
      expect(canon(migratedSpent)).toBe(canon(tot));

      for (const id of IDS) {
        expect(get(out.session.drops, id) - get(g.session.drops, id), `case ${n} drops ${id}`).toBe(get(tot, id));
        if (Object.keys(g.session.dropsBySource).length > 0) {
          expect(sumBuckets(out.session.dropsBySource, id) - sumBuckets(g.session.dropsBySource, id), `case ${n} dbs ${id}`)
            .toBe(get(tot, id));
        }
      }
      if (Object.keys(g.session.dropsBySource).length === 0) expect(out.session.dropsBySource).toEqual({});

      // session drops: only tot ids may lose their key, and only by landing on 0
      for (const id of Object.keys(g.session.drops)) {
        if (!own(out.session.drops, id)) expect(get(g.session.drops, id) + get(tot, id)).toBe(0);
      }
    }
  });

  it('buckets never go negative if they started non-negative, never decrease, zeros only where the restore landed', () => {
    const rand = rng(0xB0C4E7);
    for (let n = 0; n < N; n++) {
      const g = deepFreeze(gen(rand));
      const out = migrateSessionCost(g.session, g.rows);
      for (const [src, bucket] of Object.entries(g.session.dropsBySource)) {
        const ob = out.session.dropsBySource[src];
        expect(ob, `case ${n} bucket ${src} kept`).toBeDefined();
        for (const id of IDS) {
          const before = get(bucket, id), after = get(ob, id);
          expect(after).toBeGreaterThanOrEqual(before);
          if (before >= 0) expect(after, `case ${n} ${src}/${id}`).toBeGreaterThanOrEqual(0);
          if (own(ob, id) && ob[id] === 0) expect(before, 'a surviving zero was already stored as zero').toBe(0);
          if (own(bucket, id) && before !== 0 && after === 0) expect(own(ob, id), 'landed on 0 -> deleted').toBe(false);
        }
      }
    }
  });

  it('inputs are never mutated (deep-frozen inputs, strict mode)', () => {
    const rand = rng(0xF2023);
    for (let n = 0; n < 300; n++) {
      const g = gen(rand);
      const before = structuredClone(g);
      deepFreeze(g);
      expect(() => migrateSessionCost(g.session, g.rows)).not.toThrow();
      expect(g).toEqual(before);
    }
  });

  it('output does not alias the input', () => {
    const rand = rng(0xA11A5);
    for (let n = 0; n < 200; n++) {
      const g = gen(rand);
      const out = migrateSessionCost(g.session, g.rows);
      expect(out.session.drops).not.toBe(g.session.drops);
      for (const [k, b] of Object.entries(out.session.dropsBySource)) {
        if (own(g.session.dropsBySource, k)) expect(b).not.toBe(g.session.dropsBySource[k]);
      }
      for (const o of out.rows) {
        const src = g.rows.find(r => r.id === o.id)!;
        expect(o.drops).not.toBe(src.drops);
        expect(o.spent).not.toBe(src.spent);
      }
    }
  });

  it('deterministic across key orders of every input map and across source-bucket order', () => {
    const rand = rng(0xDE7E2);
    for (let n = 0; n < 600; n++) {
      const g = gen(rand);
      const shuffled: Gen = {
        session: {
          ...g.session,
          drops: shuffleKeys(rand, g.session.drops),
          dropsBySource: Object.fromEntries(
            Object.entries(Object.fromEntries(Object.entries(g.session.dropsBySource).map(([k, v]) => [k, shuffleKeys(rand, v)])))
              .map(x => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(x => x[1]),
          ),
        },
        rows: g.rows.map(r => ({...r, drops: shuffleKeys(rand, r.drops), spent: shuffleKeys(rand, r.spent)})),
      };
      const a = migrateSessionCost(g.session, g.rows);
      const b = migrateSessionCost(shuffled.session, shuffled.rows);
      expect(canon(b.session.drops), `case ${n}`).toBe(canon(a.session.drops));
      expect(canon(b.session.spent)).toBe(canon(a.session.spent));
      expect(canonBy(b.session.dropsBySource)).toBe(canonBy(a.session.dropsBySource));
      expect(b.rows.map(r => [r.id, canon(r.drops), canon(r.spent)])).toEqual(a.rows.map(r => [r.id, canon(r.drops), canon(r.spent)]));
      expect(b.stats).toEqual(a.stats);
    }
  });

  it('row order does not change the session result', () => {
    const rand = rng(0x0DDE2);
    for (let n = 0; n < 300; n++) {
      const g = gen(rand);
      const a = migrateSessionCost(g.session, g.rows);
      const b = migrateSessionCost(g.session, [...g.rows].reverse());
      expect(canon(b.session.drops)).toBe(canon(a.session.drops));
      expect(canon(b.session.spent)).toBe(canon(a.session.spent));
      expect(canonBy(b.session.dropsBySource)).toBe(canonBy(a.session.dropsBySource));
    }
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

describe('migrateSessionCost — edge cases', () => {
  const sess = (drops: Counts, dropsBySource: Record<string, Counts> = {}): CostSessionIn =>
    ({drops, dropsBySource, attribution: 'drop-through'});
  const row = (id: number, drops: Counts, spent: Counts, isPrimary = true): CostRowIn => ({id, drops, spent, isPrimary});

  it('float quantities: exactly-representable fractions restore exactly', () => {
    const out = migrateSessionCost(sess({'100': -1.5, '101': 0.25}), [row(1, {'100': -1.5, '101': 0.25}, {'100': 1.5, '101': 0.5})]);
    expect(out.rows[0].drops).toEqual({'101': 0.75});
    expect(out.session.drops).toEqual({'101': 0.75});
    expect(out.session.spent).toEqual({'100': 1.5, '101': 0.5});
  });

  it('float quantities: the session delta equals spent approximately', () => {
    const rand = rng(77);
    for (let n = 0; n < 300; n++) {
      const spent = Math.round(rand() * 1000) / 100;
      const drops = -spent + Math.round(rand() * 100) / 100;
      const out = migrateSessionCost(sess({'100': drops}), [row(1, {'100': drops}, {'100': spent})]);
      expect((out.session.drops['100'] ?? 0) - drops).toBeCloseTo(spent, 9);
    }
  });

  it('huge numbers: MAX_SAFE_INTEGER cost restores to exactly zero and is deleted', () => {
    const M = Number.MAX_SAFE_INTEGER;
    const out = migrateSessionCost(sess({'100': -M}, {map: {'100': -M}}), [row(1, {'100': -M}, {'100': M})]);
    expect(out.rows[0].drops).toEqual({});
    expect(out.session.drops).toEqual({});
    expect(out.session.dropsBySource).toEqual({map: {}});
    expect(out.session.spent).toEqual({'100': M});
  });

  it('huge numbers: 1e300 does not overflow into Infinity/NaN', () => {
    const out = migrateSessionCost(sess({'100': -1e300}), [row(1, {'100': -1e300}, {'100': 1e300})]);
    expect(out.rows[0].drops).toEqual({});
    expect(Number.isFinite(out.session.spent['100'])).toBe(true);
  });

  it('a spent id present in drops with value 0 is present, not stale; restored in full', () => {
    const out = migrateSessionCost(sess({'102': 0}), [row(1, {'102': 0}, {'102': 4})]);
    expect(out.rows).toEqual([{id: 1, drops: {'102': 4}, spent: {'102': 4}}]);
    expect(out.stats).toEqual({rowsMigrated: 1, staleRowsCleared: 0});
  });

  it('duplicate primaries (continued session): each row migrates, totals add', () => {
    const out = migrateSessionCost(
      sess({'100': -6}, {map: {'100': -6}}),
      [row(1, {'100': -3}, {'100': 3}), row(2, {'100': -3}, {'100': 3})],
    );
    expect(out.rows.map(r => r.drops)).toEqual([{}, {}]);
    expect(out.session.drops).toEqual({});
    expect(out.session.spent).toEqual({'100': 6});
    expect(out.session.dropsBySource).toEqual({map: {}});
  });

  it('duplicate primaries with an identical stale copy: both cleared, nothing restored', () => {
    const out = migrateSessionCost(sess({'200': 1}), [row(1, {'200': 1}, {'100': 3}), row(2, {'200': 1}, {'100': 3})]);
    expect(out.rows.map(r => r.spent)).toEqual([{}, {}]);
    expect(out.session.spent).toEqual({});
    expect(out.stats).toEqual({rowsMigrated: 0, staleRowsCleared: 2});
  });

  it('an overlap row with non-empty spent is ignored entirely', () => {
    const out = migrateSessionCost(
      sess({'100': -2}, {map: {'100': -2}}),
      [row(1, {'100': -2}, {'100': 2}, false), row(2, {}, {'999': 5}, false)],
    );
    expect(out.rows).toEqual([]);
    expect(out.session.drops).toEqual({'100': -2});
    expect(out.session.spent).toEqual({});
    expect(out.stats).toEqual({rowsMigrated: 0, staleRowsCleared: 0});
  });

  it('an overlap row next to a primary does not add to the total', () => {
    const out = migrateSessionCost(sess({'100': -2}), [row(1, {'100': -2}, {'100': 2}), row(2, {'100': -2}, {'100': 2}, false)]);
    expect(out.session.spent).toEqual({'100': 2});
    expect(out.session.drops).toEqual({});
  });

  it('empty dropsBySource stays empty, even with a cost to restore', () => {
    const out = migrateSessionCost(sess({'100': -2}, {}), [row(1, {'100': -2}, {'100': 2})]);
    expect(out.session.dropsBySource).toEqual({});
  });

  it('no rows at all: identity', () => {
    const out = migrateSessionCost(sess({'1': 2}, {map: {'1': 2}}), []);
    expect(out.session).toEqual({drops: {'1': 2}, dropsBySource: {map: {'1': 2}}, spent: {}});
    expect(out.rows).toEqual([]);
  });

  it('a spent qty of 0 on a present id (characterization): the stored 0 drops key vanishes, a zero cost entry reaches the session', () => {
    const out = migrateSessionCost(sess({'100': 0}), [row(1, {'100': 0}, {'100': 0})]);
    expect(out.rows[0].drops).toEqual({});
    expect(out.session.spent).toEqual({'100': 0});
  });

  it('prototype-ish ids never pollute and behave like any other id', () => {
    const drops = mk([['__proto__', -3], ['constructor', -1]]);
    const spent = mk([['__proto__', 3], ['constructor', 1]]);
    const out = migrateSessionCost(sess(drops, {map: drops}), [row(1, drops, spent)]);
    expect(Object.entries(out.rows[0].drops)).toEqual([]);
    expect(Object.entries(out.session.spent).sort()).toEqual([['__proto__', 3], ['constructor', 1]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out.session.spent)).toBe(Object.prototype);
  });

  it('a __proto__ spent id absent from drops (inherited, not own) is stale', () => {
    const out = migrateSessionCost(sess({}), [row(1, {}, mk([['__proto__', 2]]))]);
    expect(out.rows).toEqual([{id: 1, drops: {}, spent: {}}]);
  });

  it('restore spreads over buckets: map first, then sorted others, remainder into map', () => {
    const out = migrateSessionCost(
      sess({'100': -5}, {map: {'100': -1}, zeta: {'100': -2}, alpha: {'100': -1}}),
      [row(1, {'100': -5}, {'100': 7})],
    );
    // map: -1 -> 0 (deleted), alpha: -1 -> 0, zeta: -2 -> 0, remainder 3 -> map
    expect(out.session.dropsBySource).toEqual({map: {'100': 3}, alpha: {}, zeta: {}});
    expect(out.session.drops).toEqual({'100': 2});
  });
});

// ---------------------------------------------------------------------------
// up() over a v1 DB with many sessions
// ---------------------------------------------------------------------------

const conns: SqlConn[] = [];
afterEach(() => { while (conns.length) conns.pop()!.close(); });

interface SeedRow {mapIndex: number; parent: number | null; seasonal: string | null; drops: string; spent: string}
interface SeedSession {id: string; attribution: string; drops: string; dbs: string; rows: SeedRow[]}

/** JSON text with irregular whitespace so an untouched row is distinguishable from a rewritten one. */
const odd = (o: object, ws: boolean) => (ws ? JSON.stringify(o).replace(/[:,]/g, m => `${m} `).replace('{', '{ ') : JSON.stringify(o));

function seedSessions(count: number): SeedSession[] {
  const rand = rng(0xC0FFEE);
  const out: SeedSession[] = [];
  for (let i = 0; i < count; i++) {
    const g = gen(rand);
    const ws = rand() < 0.5;
    let idx = 0;
    const rows: SeedRow[] = g.rows.map(r => ({
      mapIndex: ++idx, parent: r.isPrimary ? null : 1, seasonal: r.isPrimary ? null : 'arcana',
      drops: odd(r.drops, ws), spent: odd(r.spent, ws),
    }));
    out.push({
      id: `s${String(i).padStart(3, '0')}`, attribution: i % 3 === 0 ? '' : 'drop-through',
      drops: odd(g.session.drops, ws), dbs: odd(g.session.dropsBySource, false), rows,
    });
  }
  return out;
}

function v1Db(sessions: SeedSession[]): SqlConn {
  const conn = openNodeSqlite();
  conn.setPragma('foreign_keys', 'ON');
  conns.push(conn);
  MIGRATIONS[0].up(conn);
  conn.setPragma('user_version', 1);
  for (const s of sessions) {
    conn.prepare(`INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops, drops_by_source, attribution, price_snapshot)
                  VALUES (?, ?, '2026-10-01T00:00:00.000Z', 60, 50, 1, ?, ?, ?, '{"100":1.5}')`)
      .run(s.id, `n-${s.id}`, s.drops, s.dbs, s.attribution);
    for (const r of s.rows) {
      conn.prepare(`INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
                    VALUES (?, ?, 1000, 2000, ?, ?, ?, ?, NULL)`)
        .run(s.id, r.mapIndex, r.drops, r.spent, r.seasonal, r.parent);
    }
  }
  return conn;
}

const dumpRows = (c: SqlConn) => c.prepare('SELECT * FROM session_maps ORDER BY id').all<Record<string, unknown>>();
const dumpSessions = (c: SqlConn) => c.prepare('SELECT * FROM sessions ORDER BY id').all<Record<string, unknown>>();

describe('MIGRATIONS[1].up over a v1 DB with many sessions', () => {
  const SEEDS = seedSessions(80);

  it('matches the pure helper per session, rewrites only changed rows, keeps untouched raw text byte-identical', () => {
    const conn = v1Db(SEEDS);
    const beforeRows = dumpRows(conn);
    const beforeSessions = dumpSessions(conn);

    const backups: string[] = [];
    runMigrations(conn, MIGRATIONS, {backup: r => backups.push(r)});
    expect(backups).toEqual(['pre-cost-migration']);

    const afterRows = dumpRows(conn);
    const afterSessions = dumpSessions(conn);
    expect(afterRows).toHaveLength(beforeRows.length);
    expect(afterSessions).toHaveLength(beforeSessions.length);

    let touchedSessions = 0, untouchedSessions = 0, untouchedRows = 0, changedRows = 0;
    for (const s of SEEDS) {
      const rowsIn = beforeRows.filter(r => r.session_id === s.id);
      const out = migrateSessionCost(
        {drops: JSON.parse(s.drops), dropsBySource: JSON.parse(s.dbs), attribution: s.attribution},
        rowsIn.map(r => ({id: r.id as number, drops: JSON.parse(r.drops as string), spent: JSON.parse(r.spent as string), isPrimary: r.parent_map_index === null})),
      );
      const changed = new Map(out.rows.map(r => [r.id, r]));

      for (const rin of rowsIn) {
        const rout = afterRows.find(r => r.id === rin.id)!;
        const c = changed.get(rin.id as number);
        if (!c) {
          untouchedRows++;
          expect(rout, `row ${rin.id} (untouched) raw`).toEqual(rin);
        } else {
          changedRows++;
          expect(JSON.parse(rout.drops as string)).toEqual(c.drops);
          expect(JSON.parse(rout.spent as string)).toEqual(c.spent);
          expect({...rout, drops: null, spent: null}).toEqual({...rin, drops: null, spent: null}); // no other column moved
        }
      }

      const sin  = beforeSessions.find(x => x.id === s.id)!;
      const sout = afterSessions.find(x => x.id === s.id)!;
      expect(sout.spent).toBeDefined();
      const {spent: _spent, drops: _d, drops_by_source: _b, ...restOut} = sout;
      const {drops: _d2, drops_by_source: _b2, ...restIn} = sin;
      expect(restOut).toEqual(restIn);
      if (Object.keys(out.session.spent).length > 0) {
        touchedSessions++;
        expect(JSON.parse(sout.drops as string)).toEqual(out.session.drops);
        expect(JSON.parse(sout.drops_by_source as string)).toEqual(out.session.dropsBySource);
        expect(JSON.parse(sout.spent as string)).toEqual(out.session.spent);
        // an exclusive-era session with buckets keeps buckets (empty dropsBySource would re-date it as legacy)
        if (Object.keys(JSON.parse(s.dbs)).length > 0) {
          expect(Object.keys(JSON.parse(sout.drops_by_source as string)).length).toBeGreaterThan(0);
        }
      } else {
        untouchedSessions++;
        expect(sout.drops).toBe(sin.drops);
        expect(sout.drops_by_source).toBe(sin.drops_by_source);
        expect(sout.spent).toBe('{}');
      }
    }
    // the seed must actually exercise both branches
    expect(touchedSessions).toBeGreaterThan(10);
    expect(untouchedSessions).toBeGreaterThan(3);
    expect(changedRows).toBeGreaterThan(20);
    expect(untouchedRows).toBeGreaterThan(20);
  });

  it('rerunning the migrations is a no-op: nothing rewritten, no backup, version stays', () => {
    const conn = v1Db(SEEDS);
    runMigrations(conn, MIGRATIONS, {backup: () => {}});
    const rows = dumpRows(conn), sessions = dumpSessions(conn);
    const backups: string[] = [];
    runMigrations(conn, MIGRATIONS, {backup: r => backups.push(r)});
    runMigrations(conn, MIGRATIONS, {backup: r => backups.push(r)});
    expect(backups).toEqual([]);
    expect(dumpRows(conn)).toEqual(rows);
    expect(dumpSessions(conn)).toEqual(sessions);
    expect(Number(conn.getPragma('user_version'))).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it('DB-level conservation: session drops delta = session spent = Σ primary row spent', () => {
    const conn = v1Db(SEEDS);
    const before = dumpSessions(conn);
    runMigrations(conn, MIGRATIONS, {backup: () => {}});
    for (const s of dumpSessions(conn)) {
      const b = before.find(x => x.id === s.id)!;
      const spent = JSON.parse(s.spent as string) as Counts;
      const d1 = JSON.parse(s.drops as string) as Counts, d0 = JSON.parse(b.drops as string) as Counts;
      for (const id of IDS) expect(get(d1, id) - get(d0, id)).toBe(get(spent, id));
      const rowSpent: Counts = {};
      for (const r of conn.prepare('SELECT spent FROM session_maps WHERE session_id = ? AND parent_map_index IS NULL').all<{spent: string}>(s.id)) {
        for (const [id, q] of Object.entries(JSON.parse(r.spent) as Counts)) add(rowSpent, id, q);
      }
      expect(canon(rowSpent)).toBe(canon(spent));
    }
  });

  it('a DB with zero sessions migrates cleanly', () => {
    const conn = v1Db([]);
    expect(() => runMigrations(conn, MIGRATIONS, {backup: () => {}})).not.toThrow();
    expect(Number(conn.getPragma('user_version'))).toBe(2);
  });
});
