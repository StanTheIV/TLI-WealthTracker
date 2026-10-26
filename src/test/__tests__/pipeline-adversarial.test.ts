/**
 * Adversarial cases for the pipeline helper: serializeGolden determinism,
 * pipelineInvariants on crafted rows, and the synthetic fixtures' lines.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';
import type {SessionAnalytics} from '@/domain/session-analytics';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import {createDispatcher} from '@/worker/create-dispatcher';
import {pipelineInvariants, runPipeline, serializeGolden, type PipelineResult} from '../pipeline';
import {GOLDEN_ITEMS} from '../golden/items';
import {SYNTHETIC_FIXTURES} from '../golden/synthetic';

const T_PROBE = Date.UTC(2026, 5, 1, 12);

const session = (over: Partial<DbSession> = {}): DbSession => ({
  id: 's', name: 'n', savedAt: 'x', totalTime: 1, mapTime: 1, mapCount: 1,
  drops: {}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {}, ...over,
});

const row = (over: Partial<DbSessionMap> = {}): DbSessionMap => ({
  sessionId: 's', mapIndex: 1, startedAt: 1000, duration: 10, drops: {}, spent: {},
  seasonalType: null, parentMapIndex: null, phase: null, ...over,
});

const analytics = (total: number, perMap: number[]): SessionAnalytics => ({
  totals:    {net: {live: total}},
  mechanics: [],
  perMap:    perMap.map(n => ({net: {live: n}})),
  meta:      {warnings: []},
} as unknown as SessionAnalytics);

function result(s: DbSession | null, rows: DbSessionMap[], a: SessionAnalytics | null): PipelineResult {
  return {
    sessions: [{id: 's', session: s, rows, analytics: a}],
    events: [], anomalies: [], linesDelivered: 0, firstTs: 1000, lastTs: 2000,
  };
}

const inv = (r: PipelineResult) => pipelineInvariants(r).s;

describe('pipelineInvariants on crafted rows', () => {
  it('clean rows pass everything', () => {
    const r = result(session(), [row({mapIndex: 1}), row({mapIndex: 2}), row({mapIndex: 3, parentMapIndex: 2, seasonalType: 'arcana'})], analytics(5, [2, 3]));
    expect(inv(r)).toEqual({
      netReconciles: {ok: true}, dropsBySourceSumsToDrops: {ok: true},
      primaryMapIndexUnique: {ok: true}, overlapHasParent: {ok: true},
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
