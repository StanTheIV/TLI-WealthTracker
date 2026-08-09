/**
 * End-to-end behaviour of computeSessionAnalytics: dual valuation, item tables,
 * derived stats, and the guards that keep a degenerate session from producing
 * NaN or Infinity anywhere in the result.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import {computeSessionAnalytics} from '../index';
import {driftPct} from '../valuation';
import {makeItems, makeSession, mapRow, overlapRow, resetRowIndex, standaloneRow} from './fixtures';

const ITEMS = makeItems({'1': 10, '2': 4}, {'1': 'card', '2': 'fuel'});

beforeEach(resetRowIndex);

/** Recursively assert no NaN/Infinity escaped into the result. */
function expectAllFinite(value: unknown, path = 'result'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => expectAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) expectAllFinite(v, `${path}.${k}`);
  }
}

describe('dual valuation', () => {
  it('values a haul at both snapshot and live prices', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10}, priceSnapshot: {'1': 8}}),
      maps:    [mapRow(300, {'1': 10})],
      items:   ITEMS,
    });

    expect(a.totals.income.snapshot).toBe(80);
    expect(a.totals.income.live).toBe(100);
    expect(a.totals.driftPct).toBeCloseTo(25, 6);
    expect(a.meta.hasSnapshot).toBe(true);
  });

  it('aliases snapshot to live when the session predates the column', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10}, priceSnapshot: {}}),
      maps:    [mapRow(300, {'1': 10})],
      items:   ITEMS,
    });

    expect(a.meta.hasSnapshot).toBe(false);
    expect(a.totals.income.snapshot).toBe(a.totals.income.live);
    expect(a.totals.driftPct).toBeNull();
  });

  it('falls back per item, so one unpriced item cannot skew the session', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10, '2': 5}, priceSnapshot: {'1': 8}}),
      maps:    [mapRow(300)],
      items:   ITEMS,
    });

    // Item 2 has no snapshot price, so it contributes its live value to both.
    expect(a.totals.income.snapshot).toBe(80 + 20);
    expect(a.totals.income.live).toBe(100 + 20);
    expect(a.dropped.find(d => d.itemId === '2')!.snapshotMissing).toBe(true);
    expect(a.dropped.find(d => d.itemId === '1')!.snapshotMissing).toBe(false);
  });

  it('reports drift as undefined rather than infinite when the snapshot is zero', () => {
    expect(driftPct({snapshot: 0, live: 50})).toBeNull();
  });

  it('treats an item deleted since save as a total loss, not a crash', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'99': 3}, priceSnapshot: {'99': 100}}),
      maps:    [mapRow(300)],
      items:   ITEMS,
    });

    const row = a.dropped.find(d => d.itemId === '99')!;
    expect(row.known).toBe(false);
    expect(row.name).toBe('#99');
    expect(row.total.snapshot).toBe(300);
    expect(row.total.live).toBe(0);
  });
});

describe('item tables', () => {
  it('lists dropped items with per-hour and maps-per-drop', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 4}, totalTime: 7200, mapCount: 8}),
      maps:    [mapRow(300, {'1': 4})],
      items:   ITEMS,
    });

    const row = a.dropped[0];
    expect(row.qty).toBe(4);
    expect(row.total.live).toBe(40);
    expect(row.perHour.live).toBe(20);      // 40 FE over 2h
    expect(row.mapsPerDrop).toBe(2);        // 8 maps / 4 drops
  });

  it('shows negative quantities verbatim but keeps them out of income', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10, '2': -5}}),
      maps:    [mapRow(300, {'1': 10, '2': -5})],
      items:   ITEMS,
    });

    expect(a.totals.income.live).toBe(100);
    const conversion = a.dropped.find(d => d.itemId === '2')!;
    expect(conversion.qty).toBe(-5);
    expect(conversion.total.live).toBe(-20);
  });

  it('unions consumed materials across runs and counts how many used each', () => {
    const a = computeSessionAnalytics({
      session: makeSession({mapCount: 2}),
      maps:    [mapRow(300, {}, {'2': 3}), mapRow(300, {}, {'2': 1})],
      items:   ITEMS,
    });

    expect(a.consumed).toHaveLength(1);
    expect(a.consumed[0]).toMatchObject({itemId: '2', qty: 4, runsUsing: 2, perMap: 2});
    expect(a.consumed[0].total.live).toBe(16);
  });

  it('picks the top source per item from the single-owner breakdown', () => {
    const a = computeSessionAnalytics({
      session: makeSession({
        drops: {'1': 10},
        dropsBySource: {map: {'1': 3}, lunaria: {'1': 7}} as never,
      }),
      maps:  [mapRow(300, {'1': 10})],
      items: ITEMS,
    });

    expect(a.dropped[0].topSource).toBe('lunaria');
    expect(a.meta.legacyBySource).toBe(false);
  });

  it('falls back to per-row aggregation for legacy sessions', () => {
    const a = computeSessionAnalytics({
      session: makeSession({attribution: 'legacy', drops: {'1': 10}, dropsBySource: {} as never}),
      maps:    [mapRow(300, {'1': 10}), overlapRow('lunaria', 60, 1, {'1': 3})],
      items:   ITEMS,
    });

    expect(a.meta.legacyBySource).toBe(true);
    expect(a.dropped[0].topSource).toBeNull();
    const total = a.bySource.reduce((s, x) => s + x.value.live, 0);
    expect(total).toBeCloseTo(100, 6);
  });
});

describe('shares follow the displayed valuation leg', () => {
  it('reports per-item share separately for snapshot and live', () => {
    // Item 1 dominates at save prices; item 2 dominates today.
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10, '2': 10}, priceSnapshot: {'1': 100, '2': 1}}),
      maps:    [mapRow(300, {'1': 10, '2': 10})],
      items:   ITEMS,
    });

    const one = a.dropped.find(d => d.itemId === '1')!;
    expect(one.pct.snapshot).toBeCloseTo((1000 / 1010) * 100, 4);
    expect(one.pct.live).toBeCloseTo((100 / 140) * 100, 4);
  });

  it('reports per-mechanic value share per leg', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10}, priceSnapshot: {'1': 8}}),
      maps:    [mapRow(300, {'1': 6}), standaloneRow('sandlord', 60, {'1': 4})],
      items:   ITEMS,
    });

    const map = a.mechanics.find(m => m.key === 'map')!;
    expect(map.valuePct.snapshot).toBeCloseTo(60, 4);
    expect(map.valuePct.live).toBeCloseTo(60, 4);
  });
});

describe('by-source breakdown', () => {
  it('does not fold an interlude overlap out of its parent', () => {
    // Arcana froze the map, so the parent row's 70 never included the 30.
    const a = computeSessionAnalytics({
      session: makeSession({attribution: 'legacy', drops: {'1': 10}, dropsBySource: {} as never}),
      maps:    [mapRow(300, {'1': 7}), overlapRow('arcana', 60, 1, {'1': 3})],
      items:   ITEMS,
    });

    const total = a.bySource.reduce((s, x) => s + x.value.live, 0);
    expect(total).toBeCloseTo(100, 6);
    expect(a.bySource.find(s => s.source === 'map')!.value.live).toBe(70);
  });

  it('clamps rather than deletes a map slice that oversubtracts', () => {
    const a = computeSessionAnalytics({
      session: makeSession({attribution: 'legacy', drops: {'1': 10}, dropsBySource: {} as never}),
      maps:    [mapRow(300, {'1': 5}), overlapRow('lunaria', 60, 1, {'1': 10})],
      items:   ITEMS,
    });

    expect(a.bySource.every(s => s.value.live >= 0)).toBe(true);
    expect(a.meta.warnings.some(w => w.code === 'overlap-exceeds-parent')).toBe(true);
  });
});

describe('derived stats', () => {
  it('computes net, ROI and break-even from income and cost', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10}, mapCount: 2, totalTime: 3600}),
      maps:    [mapRow(300, {'1': 6}, {'2': 5}), mapRow(300, {'1': 4}, {'2': 5})],
      items:   ITEMS,
    });

    expect(a.totals.income.live).toBe(100);
    expect(a.totals.cost.live).toBe(40);     // 10 units of item 2 at 4 FE
    expect(a.totals.net.live).toBe(60);
    expect(a.totals.netPerHour.live).toBe(60);
    expect(a.totals.roiMultiple.live).toBeCloseTo(2.5, 6);
    expect(a.totals.costPerMap!.live).toBe(20);
    expect(a.totals.breakEvenYield!.live).toBe(20);
  });

  it('returns a null ROI rather than Infinity when nothing was spent', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10}}),
      maps:    [mapRow(300, {'1': 10})],
      items:   ITEMS,
    });

    expect(a.totals.roiMultiple.live).toBeNull();
  });

  it('counts unprofitable runs against their own cost', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 3}, mapCount: 2}),
      maps:    [mapRow(300, {'1': 3}, {'2': 1}), mapRow(300, {}, {'2': 5})],
      items:   ITEMS,
    });

    expect(a.totals.mapsUnprofitable).toBe(1);
  });

  it('reports median separately from mean on a skewed session', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 100}, mapCount: 3}),
      maps:    [mapRow(60, {'1': 1}), mapRow(60, {'1': 2}), mapRow(60, {'1': 97})],
      items:   ITEMS,
    });

    expect(a.mapNetStats.median.live).toBe(20);
    expect(a.mapNetStats.mean.live).toBeCloseTo(1000 / 3, 6);
    expect(a.mapNetStats.best!.net.live).toBe(970);
    expect(a.mapNetStats.worst!.net.live).toBe(10);
  });

  it('puts the maximum value inside the last histogram bucket', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 10}, mapCount: 4}),
      maps:    [mapRow(60, {'1': 1}), mapRow(60, {'1': 2}), mapRow(60, {'1': 3}), mapRow(60, {'1': 4})],
      items:   ITEMS,
    });

    const counted = a.mapNetStats.histogram.reduce((s, b) => s + b.count, 0);
    expect(counted).toBe(4);
  });

  it('collapses a histogram of identical values into one bucket', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 4}, mapCount: 2}),
      maps:    [mapRow(60, {'1': 2}), mapRow(60, {'1': 2})],
      items:   ITEMS,
    });

    expect(a.mapNetStats.histogram).toHaveLength(1);
    expect(a.mapNetStats.histogram[0].count).toBe(2);
  });
});

describe('timeline', () => {
  it('nests overlap rows under their parent by index, not by time', () => {
    const a = computeSessionAnalytics({
      session: makeSession(),
      maps:    [mapRow(300), overlapRow('lunaria', 60, 1), mapRow(300)],
      items:   ITEMS,
    });

    expect(a.timeline).toHaveLength(2);
    expect(a.timeline[0].children.map(c => c.mechanic)).toEqual(['lunaria']);
    expect(a.timeline[1].children).toHaveLength(0);
  });

  it('orders by mapIndex even when startedAt disagrees', () => {
    const late  = {...mapRow(300, {}, {}, 1), startedAt: 9_000_000};
    const early = {...mapRow(300, {}, {}, 2), startedAt: 1_000_000};

    const a = computeSessionAnalytics({
      session: makeSession(),
      maps:    [late, early],
      items:   ITEMS,
    });

    expect(a.timeline.map(s => s.mapIndex)).toEqual([1, 2]);
  });
});

describe('degenerate sessions', () => {
  it('survives a session with no rows at all', () => {
    const a = computeSessionAnalytics({
      session: makeSession({totalTime: 0, mapTime: 0, mapCount: 0, drops: {}}),
      maps:    [],
      items:   ITEMS,
    });

    expect(a.meta.noMapRows).toBe(true);
    expect(a.perMap).toHaveLength(0);
    expect(a.mapNetStats.best).toBeNull();
    expectAllFinite(a);
  });

  it('survives drops with no per-run rows (legacy shape)', () => {
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 5}, mapCount: 0, totalTime: 600}),
      maps:    [],
      items:   ITEMS,
    });

    expect(a.totals.income.live).toBe(50);
    expect(a.dropped[0].mapsPerDrop).toBeNull();
    expectAllFinite(a);
  });

  it('treats a snapshot covering none of the drops as absent', () => {
    // Only a consumed material was priced — nothing about the haul is frozen,
    // so claiming 0% drift would be a fabrication.
    const a = computeSessionAnalytics({
      session: makeSession({drops: {'1': 5}, priceSnapshot: {'2': 4}}),
      maps:    [mapRow(300, {'1': 5}, {'2': 1})],
      items:   ITEMS,
    });

    expect(a.meta.hasSnapshot).toBe(false);
    expect(a.totals.driftPct).toBeNull();
  });

  it('reports no cost-per-map when no maps were run', () => {
    const a = computeSessionAnalytics({
      session: makeSession({totalTime: 600, mapTime: 0, mapCount: 0}),
      maps:    [standaloneRow('sandlord', 120, {}, {'2': 5})],
      items:   ITEMS,
    });

    expect(a.totals.cost.live).toBe(20);
    expect(a.totals.costPerMap).toBeNull();
    expect(a.totals.breakEvenYield).toBeNull();
  });

  it('counts only maps as unprofitable, not standalone seasonal runs', () => {
    const a = computeSessionAnalytics({
      session: makeSession({mapCount: 1, mapTime: 60}),
      maps:    [mapRow(60, {}, {'2': 1}), standaloneRow('sandlord', 60, {}, {'2': 1})],
      items:   ITEMS,
    });

    expect(a.totals.mapsUnprofitable).toBe(1);
  });

  it('gives an orphaned overlap a key distinct from the primary sharing its index', () => {
    // Overlap rows carry mapIndex === parentMapIndex. When the parent can't be
    // resolved the row is reclassified standalone but keeps that index, so a
    // key built from the index alone would collide with the real primary.
    const a = computeSessionAnalytics({
      session: makeSession(),
      maps:    [mapRow(300, {}, {}, 5), {...overlapRow('lunaria', 60, 5, {}), parentMapIndex: 99}],
      items:   ITEMS,
    });

    const keys = a.timeline.map(s => s.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('flags a map-count mismatch, which real sessions hit routinely', () => {
    const a = computeSessionAnalytics({
      session: makeSession({mapCount: 5}),
      maps:    [mapRow(300), standaloneRow('sandlord', 120)],
      items:   ITEMS,
    });

    expect(a.meta.warnings.some(w => w.code === 'map-count-mismatch')).toBe(true);
  });

  it('keeps every figure finite on a fully mixed session', () => {
    const a = computeSessionAnalytics({
      session: makeSession({
        totalTime: 1200, mapTime: 600, mapCount: 2,
        drops: {'1': 10, '2': -3},
        priceSnapshot: {'1': 8},
      }),
      maps: [
        mapRow(300, {'1': 6}, {'2': 2}),
        overlapRow('lunaria', 60, 1, {'1': 2}),
        mapRow(300, {'1': 4}),
        overlapRow('arcana', 90, 3, {'1': 1}),
        standaloneRow('sandlord', 150, {'1': 1}, {'2': 1}),
      ],
      items: ITEMS,
    });

    expectAllFinite(a);
    expect(a.mechanics.reduce((s, m) => s + m.timePct, 0)).toBeCloseTo(100, 6);
  });
});
