/**
 * Time and value aggregation per mechanic.
 *
 * The load-bearing rule under test: a seasonal's time is carved out of PLAIN-MAP
 * time only when it ran concurrently with a live map clock. Arcana, Vorex and
 * the Sandlord hub freeze the map, so their time was never inside
 * session.mapTime and must come out of TOWN instead — even though the engine
 * writes them as overlap rows exactly like the concurrent mechanics. Sandlord's
 * other phase, the in-map coin tile, IS concurrent while sharing its bucket.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import * as Attribution from '../attribution';
import {classifyRows, foldMapRows} from '../attribution';
import {computeSessionAnalytics} from '../index';
import {computeMechanics} from '../mechanics';
import {NO_TAX, makePriceLookup} from '@/domain/valuation';
import type {AnalyticsWarning, MechanicKey} from '../types';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import {makeItems, makeSession, mapRow, overlapRow, resetRowIndex, standaloneRow} from './fixtures';

/** Price table: item '1' is worth exactly 1 FE, so drops read as FE directly. */
const ITEMS = makeItems({'1': 1, '2': 10});

function run(session: DbSession, maps: DbSessionMap[]) {
  const warnings: AnalyticsWarning[] = [];
  // Untaxed: these assert time attribution and raw FE, so the tax would only
  // scale every expectation by 0.85. Tax itself is covered in analytics.test.ts.
  const prices   = makePriceLookup(ITEMS, session.priceSnapshot, NO_TAX);
  const rows     = classifyRows(maps, prices, warnings);
  const folded   = foldMapRows(rows, session.attribution, warnings);
  const result   = computeMechanics(session, rows, folded, warnings);
  const seconds  = (key: MechanicKey) => result.mechanics.find(m => m.key === key)?.seconds ?? 0;
  const live     = (key: MechanicKey) => result.mechanics.find(m => m.key === key)?.income.live ?? 0;
  const pctSum   = result.mechanics.reduce((s, m) => s + m.timePct, 0);
  return {result, warnings, seconds, live, pctSum};
}

beforeEach(resetRowIndex);

describe('time attribution by map-concurrency', () => {
  it('carves a CONCURRENT seasonal out of plain-map time', () => {
    // 300s map clock contains a 60s Lunaria; 600s session.
    const {seconds, pctSum} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300), overlapRow('lunaria', 60, 1)],
    );

    expect(seconds('map')).toBe(240);
    expect(seconds('lunaria')).toBe(60);
    expect(seconds('town')).toBe(300);
    expect(pctSum).toBeCloseTo(100, 6);
  });

  it('carves an INTERLUDE seasonal out of town time, leaving map time whole', () => {
    // Same shape, but Arcana froze the map — its 60s was never inside mapTime.
    const {seconds, pctSum} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300), overlapRow('arcana', 60, 1)],
    );

    expect(seconds('map')).toBe(300);   // NOT 240 — the naive rule's failure
    expect(seconds('arcana')).toBe(60);
    expect(seconds('town')).toBe(240);
    expect(pctSum).toBeCloseTo(100, 6);
  });

  it('treats a map -> hub Sandlord overlap as exclusive, not concurrent', () => {
    const {seconds} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300), overlapRow('sandlord', 120, 1, {}, 'hub')],
    );

    expect(seconds('map')).toBe(300);
    expect(seconds('sandlord')).toBe(120);
    expect(seconds('town')).toBe(180);
  });

  it('treats a phase-null Sandlord overlap as the legacy hub, not the coin tile', () => {
    // Rows written before in-map tracking existed carry no phase. Reading null
    // as 'map' would carve hub time out of map time it never occupied.
    const {seconds} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300), overlapRow('sandlord', 120, 1)],
    );

    expect(seconds('map')).toBe(300);
    expect(seconds('sandlord')).toBe(120);
    expect(seconds('town')).toBe(180);
  });

  it('carves the in-map Sandlord coin tile out of plain-map time', () => {
    const {seconds, pctSum} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300), overlapRow('sandlord', 60, 1, {}, 'map')],
    );

    expect(seconds('map')).toBe(240);
    expect(seconds('sandlord')).toBe(60);
    expect(seconds('town')).toBe(300);
    expect(pctSum).toBeCloseTo(100, 6);
  });

  it('sums both Sandlord phases into one bucket while splitting their time', () => {
    // The point of the feature: the hub's rate can no longer look good by
    // hiding the coin-farming time that fed it.
    const {seconds} = run(
      makeSession({totalTime: 900, mapTime: 300}),
      [
        mapRow(300),
        overlapRow('sandlord', 60, 1, {}, 'map'),
        overlapRow('sandlord', 120, 1, {}, 'hub'),
      ],
    );

    expect(seconds('map')).toBe(240);         // only the coin tile carves here
    expect(seconds('sandlord')).toBe(180);    // both phases, one bucket
    expect(seconds('town')).toBe(480);        // 900 - 300 - 120 hub
  });

  it('carves an in-map Hunting overlap out of plain-map time', () => {
    const {seconds, pctSum} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300), overlapRow('hunting', 90, 1)],
    );

    expect(seconds('map')).toBe(210);
    expect(seconds('hunting')).toBe(90);
    expect(seconds('town')).toBe(300);
    expect(pctSum).toBeCloseTo(100, 6);
  });

  it('carves a standalone seasonal out of town time', () => {
    const {seconds} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300), standaloneRow('sandlord', 120)],
    );

    expect(seconds('map')).toBe(300);
    expect(seconds('sandlord')).toBe(120);
    expect(seconds('town')).toBe(180);
  });

  it('keeps percentages at 100 across a mixed session', () => {
    const {seconds, pctSum} = run(
      makeSession({totalTime: 1200, mapTime: 600}),
      [
        mapRow(300),
        overlapRow('lunaria', 60, 1),
        mapRow(300),
        overlapRow('arcana', 90, 3),
        standaloneRow('sandlord', 150),
      ],
    );

    expect(seconds('map')).toBe(540);      // 600 - 60 concurrent
    expect(seconds('lunaria')).toBe(60);
    expect(seconds('arcana')).toBe(90);
    expect(seconds('sandlord')).toBe(150);
    expect(seconds('town')).toBe(360);     // 1200 - 600 - (90 + 150)
    expect(pctSum).toBeCloseTo(100, 6);
  });
});

describe('time edge cases', () => {
  it('never emits NaN when the session recorded no time', () => {
    const {result, pctSum} = run(makeSession({totalTime: 0, mapTime: 0}), []);
    expect(pctSum).toBe(0);
    for (const m of result.mechanics) {
      expect(Number.isFinite(m.timePct)).toBe(true);
      expect(Number.isFinite(m.fePerHour.live)).toBe(true);
    }
  });

  it('clamps and warns when nested time exceeds the map clock', () => {
    const {seconds, warnings, pctSum} = run(
      makeSession({totalTime: 600, mapTime: 100}),
      [mapRow(100), overlapRow('lunaria', 300, 1)],
    );

    expect(seconds('map')).toBe(0);
    expect(warnings.some(w => w.code === 'nested-exceeds-map-time')).toBe(true);
    expect(pctSum).toBeCloseTo(100, 6);
  });

  it('clamps town at zero when map + exclusive time overflow the session', () => {
    const {seconds, pctSum} = run(
      makeSession({totalTime: 300, mapTime: 300}),
      [mapRow(300), standaloneRow('sandlord', 200)],
    );

    expect(seconds('town')).toBe(0);
    expect(pctSum).toBeCloseTo(100, 6);
  });

  it('counts a zero-duration run without producing NaN averages', () => {
    const {result} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300), standaloneRow('vorex', 0)],
    );

    const vorex = result.mechanics.find(m => m.key === 'vorex')!;
    expect(vorex.runs).toBe(1);
    expect(vorex.avgSeconds).toBe(0);
    expect(vorex.fePerHour.live).toBe(0);
  });
});

describe('value attribution across eras', () => {
  const maps = () => [mapRow(300, {'1': 100}), overlapRow('lunaria', 60, 1, {'1': 30})];

  it('drop-through: parent contains the overlap, so it is folded out', () => {
    const {live} = run(makeSession({attribution: 'drop-through'}), maps());
    expect(live('map')).toBe(70);
    expect(live('lunaria')).toBe(30);
  });

  it('legacy: same folding as drop-through', () => {
    const {live} = run(makeSession({attribution: 'legacy'}), maps());
    expect(live('map')).toBe(70);
    expect(live('lunaria')).toBe(30);
  });

  it('exclusive: parent already excludes the overlap, so nothing is folded', () => {
    // The parent row holds only its own 70 in this era.
    const {live} = run(
      makeSession({attribution: 'exclusive'}),
      [mapRow(300, {'1': 70}), overlapRow('lunaria', 60, 1, {'1': 30})],
    );
    expect(live('map')).toBe(70);
    expect(live('lunaria')).toBe(30);
  });

  it('every era reaches the same session total', () => {
    const totals = (['legacy', 'drop-through'] as const).map(attribution => {
      resetRowIndex();
      const {result} = run(makeSession({attribution}), maps());
      return result.mechanics.reduce((s, m) => s + m.income.live, 0);
    });
    resetRowIndex();
    const exclusive = run(
      makeSession({attribution: 'exclusive'}),
      [mapRow(300, {'1': 70}), overlapRow('lunaria', 60, 1, {'1': 30})],
    ).result.mechanics.reduce((s, m) => s + m.income.live, 0);

    expect(totals).toEqual([100, 100]);
    expect(exclusive).toBe(100);
  });

  // FLIPPED: was 'clamps and warns...' (map own income clamped to 0).
  it('does not clamp when an overlap claims more than its parent holds: own income is negative, and warns', () => {
    const {live, warnings} = run(
      makeSession({attribution: 'drop-through'}),
      [mapRow(300, {'1': 10}), overlapRow('lunaria', 60, 1, {'1': 30})],
    );

    expect(live('map')).toBe(-20);
    expect(live('lunaria')).toBe(30);
    expect(warnings.some(w => w.code === 'overlap-exceeds-parent')).toBe(true);
  });

  // FLIPPED: was 'excludes negative quantities from income' (expected 100).
  it('counts negative quantities against income: 100 - 5 x 10 = 50', () => {
    const {live} = run(
      makeSession(),
      [mapRow(300, {'1': 100, '2': -5})],
    );
    expect(live('map')).toBe(50);
  });

  it('sums multiple overlaps on one parent', () => {
    const {live, result} = run(
      makeSession(),
      [
        mapRow(300, {'1': 100}),
        overlapRow('lunaria', 30, 1, {'1': 20}),
        overlapRow('lunaria', 30, 1, {'1': 10}),
      ],
    );

    expect(live('map')).toBe(70);
    expect(live('lunaria')).toBe(30);
    expect(result.mechanics.find(m => m.key === 'lunaria')!.runs).toBe(2);
  });

  it('folds the in-map Sandlord tile out of its parent, but never the hub', () => {
    // Drop-through only reaches an ACTIVE map: the coin tile's loot landed in
    // the parent row, the hub's did not.
    const {live} = run(
      makeSession(),
      [
        mapRow(300, {'1': 100}),
        overlapRow('sandlord', 60, 1, {'1': 30}, 'map'),
        mapRow(300, {'1': 100}),
        overlapRow('sandlord', 60, 3, {'1': 40}, 'hub'),
      ],
    );

    expect(live('map')).toBe(170);       // 100 - 30 folded, plus an untouched 100
    expect(live('sandlord')).toBe(70);
  });

  it('assigns town no income, since town drops are discarded upstream', () => {
    const {result} = run(
      makeSession({totalTime: 600, mapTime: 300}),
      [mapRow(300, {'1': 100})],
    );
    const town = result.mechanics.find(m => m.key === 'town')!;
    expect(town.income.live).toBe(0);
    expect(town.runs).toBe(0);
  });
});

describe('row classification fallbacks', () => {
  it('reclassifies an orphan overlap as standalone instead of dropping it', () => {
    const {seconds, live, warnings} = run(
      makeSession({totalTime: 600, mapTime: 0}),
      [overlapRow('lunaria', 60, 99, {'1': 25})],
    );

    expect(seconds('lunaria')).toBe(60);
    expect(live('lunaria')).toBe(25);
    expect(warnings.some(w => w.code === 'orphan-overlap-row')).toBe(true);
  });

  it('routes a null-typed overlap to `unknown` rather than guessing a mechanic', () => {
    const warnings: AnalyticsWarning[] = [];
    const prices = makePriceLookup(ITEMS, {}, NO_TAX);
    const rows = classifyRows(
      [mapRow(300, {'1': 100}), {...overlapRow('lunaria', 60, 1, {'1': 20}), seasonalType: null}],
      prices,
      warnings,
    );

    expect(rows[1].mechanic).toBe('unknown');
    expect(warnings.some(w => w.code === 'unknown-seasonal-type')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One signed valuation rule + one fold (step 1.3). These go through the public
// computeSessionAnalytics so they do not depend on the internal helper wiring.
// ---------------------------------------------------------------------------
describe('one fold, signed values (computeSessionAnalytics)', () => {
  const analyze = (session: DbSession, maps: DbSessionMap[]) =>
    computeSessionAnalytics({session, maps, items: ITEMS, tax: NO_TAX});
  const mech = (a: ReturnType<typeof analyze>, key: MechanicKey) => a.mechanics.find(m => m.key === key)!;
  const overlapWarnings = (a: ReturnType<typeof analyze>) =>
    a.meta.warnings.filter(w => w.code === 'overlap-exceeds-parent');

  it('exports foldMapRows from attribution', () => {
    expect(typeof (Attribution as Record<string, unknown>).foldMapRows).toBe('function');
  });

  it('drop-through: map income is own loot (70), cost is not added back, mechanics net sums to totals.net', () => {
    // The map row's drops hold the lunaria 30 (drop-through); its cost lives on
    // the row's `spent`, never in drops, so there is nothing to add back.
    const a = analyze(
      makeSession({drops: {'1': 100}, spent: {'2': 1}}),
      [mapRow(300, {'1': 100}, {'2': 1}), overlapRow('lunaria', 60, 1, {'1': 30})],
    );

    const map = mech(a, 'map');
    expect(map.income).toEqual({snapshot: 70, live: 70});   // NOT 80
    expect(map.cost).toEqual({snapshot: 10, live: 10});
    expect(map.net).toEqual({snapshot: 60, live: 60});
    expect(mech(a, 'lunaria').income.live).toBe(30);
    expect(mech(a, 'lunaria').net.live).toBe(30);

    expect(a.totals.income.live).toBe(100);
    expect(a.totals.cost.live).toBe(10);
    expect(a.totals.net.live).toBe(90);
    expect(a.mechanics.reduce((s, m) => s + m.net.live, 0)).toBe(90);
    expect(a.mechanics.reduce((s, m) => s + m.net.snapshot, 0)).toBe(90);
    expect(a.perMap[0].mapIncome.live).toBe(70);
    expect(a.perMap[0].net.live).toBe(90);
    expect(overlapWarnings(a)).toHaveLength(0);
  });

  it('exclusive era (parent already holds only its own 70) gives the same numbers', () => {
    const a = analyze(
      makeSession({attribution: 'exclusive', drops: {'1': 100}, spent: {'2': 1}}),
      [mapRow(300, {'1': 70}, {'2': 1}), overlapRow('lunaria', 60, 1, {'1': 30})],
    );

    expect(mech(a, 'map').income.live).toBe(70);
    expect(mech(a, 'map').cost.live).toBe(10);
    expect(mech(a, 'map').net.live).toBe(60);
    expect(mech(a, 'lunaria').income.live).toBe(30);
    expect(a.totals.net.live).toBe(90);
    expect(a.mechanics.reduce((s, m) => s + m.net.live, 0)).toBe(90);
    expect(a.perMap[0].net.live).toBe(90);
    expect(overlapWarnings(a)).toHaveLength(0);
  });

  it('mechanics map income equals perMap mapIncome (one fold, no second one)', () => {
    const a = analyze(
      makeSession({drops: {'1': 230}, spent: {'2': 2}, mapCount: 2}),
      [
        mapRow(300, {'1': 100}, {'2': 1}), overlapRow('lunaria', 60, 1, {'1': 30}),
        mapRow(300, {'1': 130}, {'2': 1}), overlapRow('hunting', 60, 2, {'1': 50}),
      ],
    );
    const perMapIncome = a.perMap.reduce((s, p) => s + p.mapIncome.live, 0);
    expect(perMapIncome).toBe(150);
    expect(mech(a, 'map').income.live).toBe(perMapIncome);
  });

  it('overlap > parent: own income is negative on both legs (not clamped), exactly one warning', () => {
    const a = analyze(
      makeSession({drops: {'1': 10}, spent: {}}),
      [mapRow(300, {'1': 10}), overlapRow('lunaria', 60, 1, {'1': 30})],
    );

    expect(mech(a, 'map').income).toEqual({snapshot: -20, live: -20});
    expect(a.perMap[0].mapIncome).toEqual({snapshot: -20, live: -20});
    expect(mech(a, 'lunaria').income.live).toBe(30);
    // The fold is computed once; mechanics + perMap must not each warn.
    expect(overlapWarnings(a)).toHaveLength(1);
    expect(overlapWarnings(a)[0]).toMatchObject({mapIndex: 1});
  });

  it('an item both spent and looted: income 100, cost 20, net 80 (everywhere)', () => {
    const a = analyze(
      makeSession({drops: {'1': 100}, spent: {'1': 20}}),
      [mapRow(300, {'1': 100}, {'1': 20})],
    );

    const map = mech(a, 'map');
    expect(map.income.live).toBe(100);
    expect(map.cost.live).toBe(20);
    expect(map.net.live).toBe(80);
    expect(a.perMap[0].net.live).toBe(80);
    expect(a.totals.income.live).toBe(100);
    expect(a.totals.cost.live).toBe(20);
    expect(a.totals.net.live).toBe(80);
  });

  it('negative drops reduce income to 70 in mechanics, perMap, totals and byType', () => {
    const a = analyze(
      makeSession({drops: {'1': 100, '2': -3}}),
      [mapRow(300, {'1': 100, '2': -3})],
    );

    expect(mech(a, 'map').income.live).toBe(70);
    expect(a.perMap[0].mapIncome.live).toBe(70);
    expect(a.totals.income.live).toBe(70);
    expect(a.totals.net.live).toBe(70);
    expect(a.byType).toHaveLength(1);
    expect(a.byType[0].value.live).toBe(70);
  });

  it('a negative overlap drop adds back to the parent fold (signed, concurrent)', () => {
    // lunaria nets 30 - 5 x 10 = -20; the parent row held 100 incl. that -20.
    const a = analyze(
      makeSession({drops: {'1': 100}}),
      [mapRow(300, {'1': 100}), overlapRow('lunaria', 60, 1, {'1': 30, '2': -5})],
    );
    expect(mech(a, 'lunaria').income.live).toBe(-20);
    expect(mech(a, 'map').income.live).toBe(120);
    expect(a.mechanics.reduce((s, m) => s + m.income.live, 0)).toBe(100);
  });

  it('a standalone seasonal keeps its income in its mechanic and contributes 0 own map income', () => {
    const a = analyze(
      makeSession({drops: {'1': 140}, spent: {'2': 1}}),
      [mapRow(300, {'1': 100}, {'2': 1}), standaloneRow('sandlord', 120, {'1': 40})],
    );
    expect(mech(a, 'sandlord').income.live).toBe(40);
    expect(mech(a, 'map').income.live).toBe(100);
    expect(a.perMap.find(p => p.mechanic === 'sandlord')!.mapIncome.live).toBe(0);
    expect(a.mechanics.reduce((s, m) => s + m.net.live, 0)).toBe(a.totals.net.live);
  });

  it('an interlude overlap is not folded out of its parent but is still part of seasonal income', () => {
    const a = analyze(
      makeSession({drops: {'1': 100}}),
      [mapRow(300, {'1': 70}), overlapRow('arcana', 60, 1, {'1': 30})],
    );
    expect(mech(a, 'map').income.live).toBe(70);
    expect(mech(a, 'arcana').income.live).toBe(30);
    expect(a.perMap[0].mapIncome.live).toBe(70);
    expect(a.perMap[0].seasonalIncome.live).toBe(30);
    expect(a.perMap[0].net.live).toBe(100);
  });
});
