/**
 * Adversarial cases for the pipeline helper: serializeGolden determinism,
 * pipelineInvariants on crafted rows, and the synthetic fixtures' lines.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';
import type {SessionAnalytics} from '@/domain/session-analytics';
import {NO_TAX} from '@/domain/valuation';
import type {DbItem, DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import type {ReplayEvent} from '@/replay/replay';
import {createDispatcher} from '@/worker/create-dispatcher';
import {pipelineInvariants, runPipeline, serializeGolden, type PipelineResult} from '../pipeline';
import {GOLDEN_ITEMS} from '../golden/items';
import {SYNTHETIC_FIXTURES} from '../golden/synthetic';

const T_PROBE = Date.UTC(2026, 5, 1, 12);

const session = (over: Partial<DbSession> = {}): DbSession => ({
  id: 's', name: 'n', savedAt: 'x', totalTime: 1, mapTime: 1, mapCount: 1,
  drops: {}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {}, spent: {}, ...over,
});

const row = (over: Partial<DbSessionMap> = {}): DbSessionMap => ({
  sessionId: 's', mapIndex: 1, startedAt: 1000, duration: 10, drops: {}, spent: {},
  seasonalType: null, parentMapIndex: null, phase: null, ...over,
});

const analytics = (total: number, perMap: number[], mechanicNets: number[] = []): SessionAnalytics => ({
  totals:    {net: {live: total}},
  mechanics: mechanicNets.map(n => ({net: {live: n}})),
  perMap:    perMap.map(n => ({net: {live: n}})),
  meta:      {warnings: []},
} as unknown as SessionAnalytics);

/** Priced 1 and 10 FE, untaxed: quantities read as FE (item 2 x10). */
const ITEMS: Record<string, DbItem> = {
  '1': {id: '1', name: 'one', type: 'other', price: 1,  priceDate: 0},
  '2': {id: '2', name: 'two', type: 'other', price: 10, priceDate: 0},
};

const ev = (event: EngineEvent, at = 0): ReplayEvent => ({event, at, lineNo: null});
const snap = (drops: Record<number, number>, spent?: Record<number, number>): TrackerSnapshot =>
  ({kind: 'session', drops, elapsed: 1, startedAt: 0, active: true, ...(spent && {spent})});

/** The engine's own view of one finished session: what `liveMatchesAnalytics`
 *  replays through the real store. The loot arrives as `drop` events (what the
 *  overlay accumulates while running) and the spent total on a session
 *  `tracker_update`; the final `tracker_finished` snapshot is NOT what gets
 *  valued (the invariant stops just before it), so it carries a decoy. */
const liveEvents = (drops: Record<number, number>, spent?: Record<number, number>): ReplayEvent[] => [
  ev({type: 'tracker_started',  tracker: snap({}), timestamp: 1}),
  ...Object.entries(drops).map(([id, change]) => ev({type: 'drop', itemId: Number(id), change, timestamp: 2} as EngineEvent)),
  ...(spent ? [ev({type: 'tracker_update', tracker: snap(drops, spent), timestamp: 3})] : []),
  ev({type: 'tracker_finished', tracker: snap({1: 1_000_000}, {2: 1_000_000}), timestamp: 4}),
];

function result(s: DbSession | null, rows: DbSessionMap[], a: SessionAnalytics | null, events: ReplayEvent[] = []): PipelineResult {
  // The pipeline owns the price table: `items`/`tax` ride on the result.
  return {
    sessions: [{id: 's', session: s, rows, analytics: a}],
    events, anomalies: [], linesDelivered: 0, firstTs: 1000, lastTs: 2000,
    items: ITEMS, tax: NO_TAX,
  };
}

const inv = (r: PipelineResult) => pipelineInvariants(r).s;

describe('pipelineInvariants on crafted rows', () => {
  it('clean rows pass everything', () => {
    const r = result(
      session(),
      [row({mapIndex: 1}), row({mapIndex: 2}), row({mapIndex: 3, parentMapIndex: 2, seasonalType: 'arcana'})],
      analytics(5, [2, 3], [3, 2]),
      liveEvents({1: 5}),
    );
    expect(inv(r)).toEqual({
      netReconciles: {ok: true}, dropsBySourceSumsToDrops: {ok: true},
      primaryMapIndexUnique: {ok: true}, overlapHasParent: {ok: true},
      liveMatchesAnalytics: {ok: true}, mechanicsNetReconciles: {ok: true},
    });
  });

  it('duplicate primary mapIndex: delta = number of extra rows', () => {
    const r = result(session(), [row({mapIndex: 1}), row({mapIndex: 1}), row({mapIndex: 1})], analytics(0, []));
    expect(inv(r).primaryMapIndexUnique).toEqual({ok: false, delta: 2});
  });

  it('an overlap sharing a primary mapIndex is not a duplicate', () => {
    const r = result(session(), [row({mapIndex: 1}), row({mapIndex: 1, parentMapIndex: 1, seasonalType: 'arcana'})], analytics(0, []));
    expect(inv(r).primaryMapIndexUnique).toEqual({ok: true});
  });

  it('orphan overlap (parent absent) is counted', () => {
    const r = result(session(), [row({mapIndex: 1}), row({mapIndex: 2, parentMapIndex: 9, seasonalType: 'arcana'})], analytics(0, []));
    expect(inv(r).overlapHasParent).toEqual({ok: false, delta: 1});
  });

  it('an overlap whose parent is itself an overlap is an orphan', () => {
    const r = result(session(), [
      row({mapIndex: 1}),
      row({mapIndex: 2, parentMapIndex: 1, seasonalType: 'arcana'}),
      row({mapIndex: 3, parentMapIndex: 2, seasonalType: 'vorex'}),
    ], analytics(0, []));
    expect(inv(r).overlapHasParent).toEqual({ok: false, delta: 1});
  });

  it('dropsBySource mismatch: sum of |difference| over the union of ids', () => {
    const s = session({
      drops: {a: 10, b: 5},
      dropsBySource: {map: {a: 4}, arcana: {a: 3, c: 2}},
    });
    // a: 7 vs 10 -> 3, b: 0 vs 5 -> 5, c: 2 vs 0 -> 2
    expect(inv(result(s, [], analytics(0, []))).dropsBySourceSumsToDrops).toEqual({ok: false, delta: 10});
  });

  it('negative quantities cancel across sources exactly', () => {
    const s = session({drops: {a: 0}, dropsBySource: {map: {a: 5}, arcana: {a: -5}}});
    expect(inv(result(s, [], analytics(0, []))).dropsBySourceSumsToDrops).toEqual({ok: true});
  });

  it('an undefined per-source entry does not throw', () => {
    const s = session({drops: {}, dropsBySource: {map: undefined}});
    expect(inv(result(s, [], analytics(0, []))).dropsBySourceSumsToDrops).toEqual({ok: true});
  });

  it('net reconcile tolerance: 5e-7 is noise, 2e-6 is a failure, sign preserved', () => {
    expect(inv(result(session(), [], analytics(10, [10 + 5e-7]))).netReconciles).toEqual({ok: true});
    const bad = inv(result(session(), [], analytics(10, [10 - 2e-6]))).netReconciles;
    expect(bad.ok).toBe(false);
    expect(bad.delta).toBeCloseTo(-2e-6, 12);
  });

  it('net reconcile with NaN is a failure, not a pass', () => {
    expect(inv(result(session(), [], analytics(1, [NaN]))).netReconciles.ok).toBe(false);
  });

  describe('mechanicsNetReconciles', () => {
    const mech = (total: number, nets: number[]) => inv(result(session(), [], analytics(total, [], nets))).mechanicsNetReconciles;

    it('passes when the mechanics nets re-add to totals.net', () => {
      expect(mech(10, [6, 4])).toEqual({ok: true});
      expect(mech(-5, [-8, 3])).toEqual({ok: true});
    });

    it('fails with the signed delta (sum of mechanics - total)', () => {
      expect(mech(10, [6, 3])).toEqual({ok: false, delta: -1});
      expect(mech(10, [6, 7])).toEqual({ok: false, delta: 3});
    });

    it('tolerance: 5e-7 is noise, 2e-6 is a failure', () => {
      expect(mech(10, [6, 4 + 5e-7])).toEqual({ok: true});
      const bad = mech(10, [6, 4 - 2e-6]);
      expect(bad.ok).toBe(false);
      expect(bad.delta).toBeCloseTo(-2e-6, 12);
    });

    it('NaN is a failure, not a pass', () => {
      expect(mech(1, [NaN]).ok).toBe(false);
    });
  });

  describe('liveMatchesAnalytics', () => {
    // Items: '1' = 1 FE, '2' = 10 FE, untaxed. The invariant replays the events
    // through the REAL engineStore and values its session state (what the
    // overlay's Total shows) against analytics.totals.net.live.
    const live = (net: number, events: ReplayEvent[], s = session()) =>
      inv(result(s, [], analytics(net, []), events)).liveMatchesAnalytics;

    it('passes when the store-driven live net equals analytics net (signed drops, spent)', () => {
      // loot 100 - 3 x 10 = 70, cost 1 x 10 -> net 60
      expect(live(60, liveEvents({1: 100, 2: -3}, {2: 1}))).toEqual({ok: true});
    });

    it('passes with no spent on the final snapshot (cost 0)', () => {
      expect(live(100, liveEvents({1: 100}))).toEqual({ok: true});
    });

    it('fails with the delta when the live total and analytics disagree', () => {
      const bad = live(65, liveEvents({1: 100, 2: -3}, {2: 1}));
      expect(bad.ok).toBe(false);
      expect(Math.abs(bad.delta!)).toBeCloseTo(5, 9);
    });

    it('fails when analytics clamped what the live view did not (the old bug)', () => {
      // analytics (old clamp) = 100; live signed = 70.
      const bad = live(100, liveEvents({1: 100, 2: -3}));
      expect(bad.ok).toBe(false);
      expect(Math.abs(bad.delta!)).toBeCloseTo(30, 9);
    });

    it('tolerance: 5e-7 is noise, 2e-6 is a failure', () => {
      expect(live(60 + 5e-7, liveEvents({1: 100, 2: -3}, {2: 1}))).toEqual({ok: true});
      const bad = live(60 + 2e-6, liveEvents({1: 100, 2: -3}, {2: 1}));
      expect(bad.ok).toBe(false);
      expect(Math.abs(bad.delta!)).toBeCloseTo(2e-6, 12);
    });

    it('reads the events, not session.drops (which would be tautological)', () => {
      const s = session({drops: {'1': 999}, spent: {'2': 99}});
      expect(live(5, liveEvents({1: 5}), s)).toEqual({ok: true});
    });

    it('values the state immediately BEFORE the session tracker_finished: the drop accumulation, not the final snapshot', () => {
      const events = [
        ev({type: 'tracker_started',  tracker: snap({}), timestamp: 1}),
        ev({type: 'drop', itemId: 1, change: 5, timestamp: 2} as EngineEvent),
        ev({type: 'tracker_finished', tracker: snap({1: 100}), timestamp: 3}),
      ];
      expect(live(5, events)).toEqual({ok: true});
      const bad = live(100, events);   // what the old, final-snapshot check would have accepted
      expect(bad.ok).toBe(false);
      expect(bad.delta).toBeCloseTo(-95, 9);
    });

    it('a run without a session tracker_finished is valued after its last event', () => {
      const events = [
        ev({type: 'tracker_started', tracker: snap({}), timestamp: 1}),
        ev({type: 'drop', itemId: 2, change: 3, timestamp: 2} as EngineEvent),
        ev({type: 'drop', itemId: 1, change: -4, timestamp: 3} as EngineEvent),
      ];
      expect(live(26, events)).toEqual({ok: true});
    });

    it('a map or seasonal tracker_finished does not stop the replay; only the session one does', () => {
      const events = [
        ev({type: 'tracker_started',  tracker: snap({}), timestamp: 1}),
        ev({type: 'drop', itemId: 1, change: 5, timestamp: 2} as EngineEvent),
        ev({type: 'tracker_finished', tracker: {kind: 'map', drops: {1: 5}, elapsed: 1, startedAt: 0, active: false}, timestamp: 3}),
        ev({type: 'drop', itemId: 1, change: 7, timestamp: 4} as EngineEvent),
        ev({type: 'tracker_finished', tracker: snap({1: 12}), timestamp: 5}),
        ev({type: 'drop', itemId: 1, change: 1000, timestamp: 6} as EngineEvent),   // after stop: not part of the run's Total
      ];
      expect(live(12, events)).toEqual({ok: true});
    });

    it('an empty event list is a zero Total', () => {
      expect(live(0, [])).toEqual({ok: true});
      expect(live(1, []).delta).toBe(-1);
    });

    it('two runs in one stream are valued independently (the store is reset per run)', () => {
      const runEvents = (n: number, at: number) => [
        ev({type: 'init_started'} as EngineEvent, at),
        ev({type: 'tracker_started', tracker: snap({}), timestamp: at}, at),
        ev({type: 'drop', itemId: 1, change: n, timestamp: at} as EngineEvent, at),
        ev({type: 'tracker_finished', tracker: snap({1: n}), timestamp: at}, at),
      ];
      const r: PipelineResult = {
        sessions: [
          {id: 'a', session: session(), rows: [], analytics: analytics(3, [])},
          {id: 'b', session: session(), rows: [], analytics: analytics(9, [])},
        ],
        events: [...runEvents(3, 1), ...runEvents(9, 2)],
        anomalies: [], linesDelivered: 0, firstTs: 0, lastTs: 0, items: ITEMS, tax: NO_TAX,
      };
      const out = pipelineInvariants(r);
      expect(out.a.liveMatchesAnalytics).toEqual({ok: true});
      expect(out.b.liveMatchesAnalytics).toEqual({ok: true});
    });

    it('follows spent from the last session snapshot, including a tracker_update', () => {
      const events = [
        ev({type: 'tracker_started', tracker: snap({}), timestamp: 1}),
        ev({type: 'drop', itemId: 1, change: 50, timestamp: 2}),
        ev({type: 'tracker_update',  tracker: snap({1: 50}, {2: 1}), timestamp: 3}),
        ev({type: 'tracker_update',  tracker: snap({1: 50}, {2: 2}), timestamp: 4}),
      ];
      expect(live(30, events)).toEqual({ok: true});   // 50 - 2 x 10
    });
  });

  it('unsaved sessions and null analytics produce no invariants', () => {
    expect(pipelineInvariants(result(null, [], null))).toEqual({});
    expect(pipelineInvariants(result(session(), [], null))).toEqual({});
  });
});

describe('serializeGolden determinism', () => {
  const build = (drops: Record<string, number>, snap: Record<string, number>, rowOver: Partial<DbSessionMap> = {}) =>
    result(session({drops, priceSnapshot: snap}), [row(rowOver)], null);

  it('is independent of object key insertion order, at every depth', () => {
    const a = build({x: 1, a: 2, m: {q: 1, b: 2} as never}, {z: 1, y: 2});
    const b = build({m: {b: 2, q: 1} as never, a: 2, x: 1}, {y: 2, z: 1});
    expect(serializeGolden(a)).toBe(serializeGolden(b));
  });

  it('sorts keys inside objects nested in arrays but keeps array order', () => {
    const r = result(session(), [row({drops: {b: 1, a: 1}, mapIndex: 2}), row({drops: {d: 1, c: 1}, mapIndex: 1})], null);
    const doc = JSON.parse(serializeGolden(r));
    expect(doc.sessions[0].rows.map((x: DbSessionMap) => x.mapIndex)).toEqual([2, 1]);
    expect(Object.keys(doc.sessions[0].rows[0].drops)).toEqual(['a', 'b']);
  });

  it('is stable across repeated serialisation', () => {
    const r = build({a: 1}, {a: 0.1 + 0.2});
    expect(serializeGolden(r)).toBe(serializeGolden(r));
  });

  it('normalises -0, sub-micro noise and non-finite numbers', () => {
    const r = build({neg0: -0, tiny: -1e-7, pos: 1e-7, nan: NaN, inf: Infinity, ninf: -Infinity, third: 1 / 3}, {});
    const drops = JSON.parse(serializeGolden(r)).sessions[0].totals.drops;
    expect(drops).toEqual({neg0: 0, tiny: 0, pos: 0, nan: 'NaN', inf: 'Infinity', ninf: '-Infinity', third: 0.333333});
    expect(serializeGolden(r)).not.toContain('-0');
  });

  it('drops undefined values and ends with a newline', () => {
    const out = serializeGolden(build({a: undefined as never}, {}));
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out).sessions[0].totals.drops).toEqual({});
  });

  it('is relative to the first line: shifting every absolute time leaves it unchanged', () => {
    const at = (shift: number) => ({
      ...result(session(), [row({startedAt: 5000 + shift})], null), firstTs: 1000 + shift, lastTs: 9000 + shift,
    });
    expect(serializeGolden(at(0))).toBe(serializeGolden(at(86_400_000 * 123)));
  });

  it('does not leak id/name/savedAt', () => {
    const out = serializeGolden(result(session({name: 'SECRET-NAME', savedAt: 'SECRET-DATE'}), [], null));
    expect(out).not.toContain('SECRET');
  });

  it('the same pipeline run twice serialises identically (clock-independent)', async () => {
    const text = SYNTHETIC_FIXTURES['carjack-stop-after-dormancy'];
    const a = serializeGolden(await runPipeline(text, {items: GOLDEN_ITEMS}));
    const b = serializeGolden(await runPipeline(text, {items: GOLDEN_ITEMS}));
    expect(a).toBe(b);
  });

  it('does not depend on the item table key order', async () => {
    const text = SYNTHETIC_FIXTURES['map-vorex'];
    const reversed = Object.fromEntries(Object.entries(GOLDEN_ITEMS).reverse());
    expect(serializeGolden(await runPipeline(text, {items: reversed}))).toBe(serializeGolden(await runPipeline(text, {items: GOLDEN_ITEMS})));
  });

  it('does not depend on the process timezone', async () => {
    const text = readFileSync(join(__dirname, '../golden/fixtures/plain-map-cost.log'), 'utf8');
    const original = process.env.TZ;
    const outs: string[] = [];
    const offsets = new Set<number>();
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        offsets.add(new Date(T_PROBE).getTimezoneOffset());
        outs.push(serializeGolden(await runPipeline(text, {items: GOLDEN_ITEMS})));
      }
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
    // The assignment must really change the zone, or this proves nothing.
    expect(offsets.size).toBe(3);
    expect(outs[1]).toBe(outs[0]);
    expect(outs[2]).toBe(outs[0]);
  });
});

describe('synthetic fixtures parse into the intended events', () => {
  // Lines the scenarios include on purpose that the processors ignore.
  const IGNORED = ['ShouYe_YouHun_App', 'ShouYe_Box_App', 'Mon_DisAppear'];

  const types = (text: string) => {
    const d = createDispatcher();
    return text.split('\n').filter(Boolean).map(l => ({l, t: d.dispatch(l).map(e => e.type)}));
  };

  it.each(Object.entries(SYNTHETIC_FIXTURES))('%s: only the deliberately ignored lines match nothing', (_n, text) => {
    for (const {l, t} of types(text)) {
      if (t.length === 0) expect(IGNORED.some(m => l.includes(m)), l).toBe(true);
      else expect(t, l).toHaveLength(1);
    }
  });

  it('map-vorex yields the Vorex trio in order, between zone changes', () => {
    const seq = types(SYNTHETIC_FIXTURES['map-vorex']).flatMap(x => x.t).filter(t => t.startsWith('s13') || t === 'zone_transition');
    expect(seq).toEqual(['zone_transition', 's13_start', 's13_window_close', 's13_abandon', 'zone_transition', 'zone_transition']);
  });

  it('afterlight-special-no-win: start, special, five waves, one end, no _Win', () => {
    const seq = types(SYNTHETIC_FIXTURES['afterlight-special-no-win']).flatMap(x => x.t).filter(t => t.startsWith('afterlight'));
    expect(seq).toEqual(['afterlight_start', 'afterlight_special', ...Array(5).fill('afterlight_wave'), 'afterlight_end']);
  });

  it('carjack: one start, six waves (appear + five kills), the Stop twice', () => {
    const seq = types(SYNTHETIC_FIXTURES['carjack-stop-after-dormancy']).flatMap(x => x.t).filter(t => t.startsWith('s11'));
    expect(seq).toEqual(['s11_start', ...Array(6).fill('s11_wave'), 's11_end', 's11_end']);
  });

  it.each(Object.entries(SYNTHETIC_FIXTURES))('%s: timestamps are non-decreasing', (_n, text) => {
    const ms = text.split('\n').filter(Boolean).map(l => {
      const m = /^\[(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d):(\d{3})\]/.exec(l)!;
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
    });
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]);
  });
});
