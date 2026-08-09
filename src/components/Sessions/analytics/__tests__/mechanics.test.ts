/**
 * Time and value aggregation per mechanic.
 *
 * The load-bearing rule under test: a seasonal's time is carved out of PLAIN-MAP
 * time only when it ran concurrently with a live map clock. Arcana, Vorex and
 * Sandlord freeze the map, so their time was never inside session.mapTime and
 * must come out of TOWN instead — even though the engine writes them as overlap
 * rows exactly like the concurrent mechanics.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import {classifyRows} from '../attribution';
import {computeMechanics} from '../mechanics';
import {makePriceLookup, makeValuator} from '../valuation';
import type {AnalyticsWarning, MechanicKey} from '../types';
import type {DbSession, DbSessionMap} from '@/types/electron';
import {makeItems, makeSession, mapRow, overlapRow, resetRowIndex, standaloneRow} from './fixtures';

/** Price table: item '1' is worth exactly 1 FE, so drops read as FE directly. */
const ITEMS = makeItems({'1': 1, '2': 10});

function run(session: DbSession, maps: DbSessionMap[]) {
  const warnings: AnalyticsWarning[] = [];
  const prices   = makePriceLookup(ITEMS, session.priceSnapshot);
  const income   = makeValuator(prices, {clampNegative: true});
  const rows     = classifyRows(maps, income, warnings);
  const result   = computeMechanics(session, rows, warnings);
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
      [mapRow(300), overlapRow('sandlord', 120, 1)],
    );

    expect(seconds('map')).toBe(300);
    expect(seconds('sandlord')).toBe(120);
    expect(seconds('town')).toBe(180);
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

  it('clamps and warns when an overlap claims more than its parent holds', () => {
    const {live, warnings} = run(
      makeSession({attribution: 'drop-through'}),
      [mapRow(300, {'1': 10}), overlapRow('lunaria', 60, 1, {'1': 30})],
    );

    expect(live('map')).toBe(0);
    expect(live('lunaria')).toBe(30);
    expect(warnings.some(w => w.code === 'overlap-exceeds-parent')).toBe(true);
  });

  it('excludes negative quantities from income (auction-house conversions)', () => {
    const {live} = run(
      makeSession(),
      [mapRow(300, {'1': 100, '2': -5})],
    );
    expect(live('map')).toBe(100);
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
    const prices = makePriceLookup(ITEMS, {});
    const rows = classifyRows(
      [mapRow(300, {'1': 100}), {...overlapRow('lunaria', 60, 1, {'1': 20}), seasonalType: null}],
      makeValuator(prices, {clampNegative: true}),
      warnings,
    );

    expect(rows[1].mechanic).toBe('unknown');
    expect(warnings.some(w => w.code === 'unknown-seasonal-type')).toBe(true);
  });
});
