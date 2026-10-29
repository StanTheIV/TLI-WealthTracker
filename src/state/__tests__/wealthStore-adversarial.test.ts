/**
 * 4.5 adversarial: wealthStore under interleaved requests and out-of-order
 * responses. The newest request always wins, and a recorded point is neither
 * lost nor duplicated.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {WealthLatestBreakdown, WealthSeriesPoint} from '@/shared/contracts/wealth';
import {DAY_MS, HOUR_MS, deferred, flush, pt, wealthHarness} from './wealth-harness';
import {int, rng} from '@/test/prng';

const NOW = 1_800_000_000_000;
let now = NOW;

beforeEach(() => {
  vi.unstubAllGlobals();
  now = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); });

type Deferred<V> = ReturnType<typeof deferred<V>>;

/** Series / latest answers held until the test releases them; each answer is
 *  the table as it was when the request was made (as main would read it). */
async function heldHarness(rows: WealthSeriesPoint[] = []) {
  const t = await wealthHarness({rows});
  await t.s().load();
  const heldSeries: Array<{d: Deferred<WealthSeriesPoint[]>; range: [number, number]}> = [];
  const heldLatest: Array<Deferred<WealthLatestBreakdown | null>> = [];
  t.series.mockImplementation(((from: number, to: number) => {
    const d = deferred<WealthSeriesPoint[]>();
    d.resolve(t.rows().filter(r => r.ts >= from && r.ts <= to).sort((a, b) => a.ts - b.ts));
    const gate = deferred<WealthSeriesPoint[]>();
    heldSeries.push({d: gate, range: [from, to]});
    const snapshot = d.promise;
    return gate.promise.then(() => snapshot);
  }) as never);
  t.latestBreakdown.mockImplementation((() => {
    const last = [...t.rows()].sort((a, b) => a.ts - b.ts).at(-1);
    const snap: WealthLatestBreakdown | null = last ? {...last, rows: []} : null;
    const gate = deferred<WealthLatestBreakdown | null>();
    heldLatest.push(gate);
    return gate.promise.then(() => snap);
  }) as never);
  return {t, heldSeries, heldLatest};
}

describe('newest request wins', () => {
  it('setRange(1d) then setRange(all): a late 1d answer never overwrites all, either release order', async () => {
    for (const lateFirst of [true, false]) {
      const rows = [pt(1, NOW - 10 * DAY_MS), pt(2, NOW - HOUR_MS)];
      const {t, heldSeries, heldLatest} = await heldHarness(rows);
      const a = t.s().setRange('1d');
      const b = t.s().setRange('all');
      expect(heldSeries.map(h => h.range[0])).toEqual([NOW - DAY_MS, 0]);
      const releaseA = () => { heldSeries[0].d.resolve([]); heldLatest[0].resolve(null); };
      const releaseB = () => { heldSeries[1].d.resolve([]); heldLatest[1].resolve(null); };
      if (lateFirst) { releaseB(); await flush(); releaseA(); } else { releaseA(); await flush(); releaseB(); }
      await Promise.all([a, b]);
      expect(t.s().range).toBe('all');
      expect(t.s().points.map(p => p.id)).toEqual([1, 2]);
    }
  });

  it('a refresh issued after setRange wins over the setRange answer arriving later', async () => {
    const {t, heldSeries, heldLatest} = await heldHarness([pt(1, NOW - HOUR_MS)]);
    const a = t.s().setRange('3d');
    const b = t.s().refresh();
    heldSeries[1].d.resolve([]); heldLatest[1].resolve(null);
    await flush();
    heldSeries[0].d.resolve([]); heldLatest[0].resolve(null);
    await Promise.all([a, b]);
    expect(t.s().points.map(p => p.id)).toEqual([1]);
  });

  it('a failed newest request does not wedge the store: the next refresh lands', async () => {
    const {t, heldSeries, heldLatest} = await heldHarness([pt(1, NOW - HOUR_MS)]);
    const a = t.s().refresh();
    heldSeries[0].d.resolve([]); heldLatest[0].resolve(null);
    await a;
    t.series.mockImplementationOnce((() => Promise.reject(new Error('boom'))) as never);
    await expect(t.s().refresh()).rejects.toThrow('boom');
    const c = t.s().refresh();
    heldSeries[1].d.resolve([]); heldLatest[2].resolve(null);
    await c;
    expect(t.s().points.map(p => p.id)).toEqual([1]);
    // and a recording still appends after the failure
    t.record(pt(7, NOW - 5));
    expect(t.s().points.map(p => p.id)).toEqual([1, 7]);
  });
});

describe('appends vs in-flight responses', () => {
  it('a point recorded while a request is in flight (snapshot predates it) is merged, once, in ts order', async () => {
    const {t, heldSeries, heldLatest} = await heldHarness([pt(1, NOW - 3 * HOUR_MS), pt(3, NOW - HOUR_MS)]);
    const a = t.s().refresh();
    t.record(pt(2, NOW - 2 * HOUR_MS)); // between the two, after the snapshot
    heldSeries[0].d.resolve([]); heldLatest[0].resolve(null);
    await a;
    expect(t.s().points.map(p => p.id)).toEqual([1, 2, 3]);
  });

  it('a point recorded before the snapshot (so inside it) is not doubled by the merge', async () => {
    const {t, heldSeries, heldLatest} = await heldHarness([pt(1, NOW - 3 * HOUR_MS)]);
    const a = t.s().refresh();
    t.record(pt(2, NOW - HOUR_MS));
    const b = t.s().refresh(); // snapshot now includes 2; list reset
    for (const h of heldSeries) h.d.resolve([]);
    for (const h of heldLatest) h.resolve(null);
    await Promise.all([a, b]);
    expect(t.s().points.map(p => p.id)).toEqual([1, 2]);
  });

  it('the same wealth_recorded delivered twice replaces, never duplicates', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS)]});
    await t.s().load();
    t.record(pt(2, NOW - 100));
    t.announce(pt(2, NOW - 100));
    t.announce({...pt(2, NOW - 100), value: 5});
    expect(t.s().points.filter(p => p.id === 2)).toEqual([{id: 2, ts: NOW - 100, value: 5}]);
  });

  it('out-of-order recordings (older ts after newer) stay sorted by ts', async () => {
    const t = await wealthHarness();
    await t.s().load();
    for (const [id, off] of [[1, 10], [2, 50], [3, 30], [4, 40], [5, 20]] as const) t.record(pt(id, NOW - off * 1000));
    expect(t.s().points.map(p => p.id)).toEqual([2, 4, 3, 5, 1]);
  });

  it('a delete announced while a request is in flight: the deleted point is gone once everything settles', async () => {
    const {t, heldSeries, heldLatest} = await heldHarness([pt(1, NOW - 2 * HOUR_MS), pt(2, NOW - HOUR_MS)]);
    const a = t.s().refresh();            // snapshot has 1, 2
    const del = t.s().deletePoint(2);     // removes, announces, refresh B (snapshot: 1)
    for (const h of heldSeries.slice().reverse()) h.d.resolve([]); // stale A last-issued-first order
    for (const h of heldLatest) h.resolve(null);
    await Promise.all([a, del]);
    await flush();
    expect(t.s().points.map(p => p.id)).toEqual([1]);
    expect(t.s().latest?.id).toBe(1);
  });
});

describe('random interleavings (property)', () => {
  it('after everything settles the store equals the table: no lost, duplicated or stale point', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed * 101);
      const {t, heldSeries, heldLatest} = await heldHarness([pt(1, NOW - 5000), pt(2, NOW - 9000)]);
      let nextId = 10;
      const inFlight: Promise<unknown>[] = [];
      const releaseSome = async () => {
        // release a random pending item (order is the shuffle)
        const unreleasedS = heldSeries.filter(h => !(h as {done?: boolean}).done);
        const unreleasedL = heldLatest.filter(h => !(h as {done?: boolean}).done);
        if (unreleasedS.length > 0 && r() < 0.6) {
          const h = unreleasedS[int(r, 0, unreleasedS.length - 1)];
          (h as {done?: boolean}).done = true; h.d.resolve([]);
        } else if (unreleasedL.length > 0) {
          const h = unreleasedL[int(r, 0, unreleasedL.length - 1)];
          (h as {done?: boolean}).done = true; h.resolve(null);
        }
        await flush();
      };

      for (let step = 0; step < 50; step++) {
        const op = r();
        if (op < 0.3) {
          const id = nextId++;
          t.record(pt(id, NOW - int(r, 1, 3_000_000), id));
        } else if (op < 0.45) {
          inFlight.push(t.s().refresh().catch(() => undefined));
        } else if (op < 0.6) {
          inFlight.push(t.s().setRange((['1d', '3d', '7d', '1m', 'all'] as const)[int(r, 0, 4)]).catch(() => undefined));
        } else if (op < 0.7) {
          t.changed();
        } else if (op < 0.78 && t.rows().length > 0) {
          const victim = t.rows()[int(r, 0, t.rows().length - 1)];
          inFlight.push(t.s().deletePoint(victim.id).catch(() => undefined));
        }
        for (let k = int(r, 0, 3); k > 0; k--) await releaseSome();
      }
      // settle: release everything left, in random order
      for (let guard = 0; guard < 500; guard++) {
        const left = heldSeries.some(h => !(h as {done?: boolean}).done) || heldLatest.some(h => !(h as {done?: boolean}).done);
        if (!left) break;
        await releaseSome();
      }
      await Promise.all(inFlight);
      await flush();

      const expected = [...t.rows()].sort((a, b) => a.ts - b.ts);
      const got = t.s().points;
      expect(got.map(p => p.id), `seed ${seed}`).toEqual(expected.map(p => p.id));
      expect(new Set(got.map(p => p.id)).size).toBe(got.length);
      expect(t.s().latest?.id ?? null, `seed ${seed} latest`).toBe(expected.at(-1)?.id ?? null);
    }
  });
});

describe('range trimming', () => {
  it('drops points older than from on an append; ts == from stays, from-1 goes', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - DAY_MS - 1000), pt(2, NOW - DAY_MS), pt(3, NOW - HOUR_MS)], storedRange: '1d'});
    now = NOW;
    await t.s().load();
    // load asked from NOW - DAY: row 1 excluded by the table, 2 (== from) included
    expect(t.s().points.map(p => p.id)).toEqual([2, 3]);
    now = NOW + 1;                        // from moves 1ms forward: 2 is now one ms too old
    t.record(pt(4, NOW));
    expect(t.s().points.map(p => p.id)).toEqual([3, 4]);
  });

  it('a recorded point already older than the window is not shown', async () => {
    const t = await wealthHarness({storedRange: '1d'});
    await t.s().load();
    t.announce(pt(9, NOW - DAY_MS - 1));
    expect(t.s().points).toEqual([]);
  });

  it("'all' never trims, even when the clock is years ahead", async () => {
    const t = await wealthHarness({rows: [pt(1, 1), pt(2, 1000)], storedRange: 'all'});
    await t.s().load();
    now = NOW + 10 * 365 * DAY_MS;
    t.record(pt(3, now));
    expect(t.s().points.map(p => p.id)).toEqual([1, 2, 3]);
  });

  it('switching to a narrower range then appending trims by the NEW range', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - 20 * DAY_MS), pt(2, NOW - 2 * DAY_MS), pt(3, NOW - HOUR_MS)], storedRange: 'all'});
    await t.s().load();
    expect(t.s().points.map(p => p.id)).toEqual([1, 2, 3]);
    await t.s().setRange('1d');
    expect(t.s().points.map(p => p.id)).toEqual([3]);
    t.record(pt(4, NOW - 10));
    expect(t.s().points.map(p => p.id)).toEqual([3, 4]);
  });
});
