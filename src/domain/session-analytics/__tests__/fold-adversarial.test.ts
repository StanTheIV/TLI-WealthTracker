/**
 * Adversarial cases for the one fold (`foldMapRows`) and the signed rule's
 * session-level invariants: every section of an analytics pass must agree on
 * what a map earned, what the session earned and what it cost.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import {classifyRows, foldMapRows} from '../attribution';
import {computeSessionAnalytics} from '../index';
import {AUCTION_TAX_RATE, NO_TAX, makePriceLookup, type TaxConfig} from '@/domain/valuation';
import type {AnalyticsWarning, SessionAnalytics} from '../types';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {SeasonalPhase, SeasonalType} from '@/shared/contracts/engine';
import {makeItems, makeRow, makeSession, mapRow, overlapRow, resetRowIndex, standaloneRow} from './fixtures';

/** '1' = 1 FE, '2' = 10 FE, '3' = 5 FE fuel (untaxed). */
const ITEMS = makeItems({'1': 1, '2': 10, '3': 5}, {'3': 'fuel'});
const TAX_ON: TaxConfig = {enabled: true, rate: AUCTION_TAX_RATE};

type Attribution = DbSession['attribution'];

function fold(maps: DbSessionMap[], era: Attribution = 'drop-through', snapshot: Record<string, number> = {}) {
  const warnings: AnalyticsWarning[] = [];
  const prices = makePriceLookup(ITEMS, snapshot, NO_TAX, ['1', '2', '3']);
  const classified = classifyRows(maps, prices, warnings);
  const folded = foldMapRows(classified, era, warnings);
  return {folded, warnings, classified};
}

const overlapWarnings = (w: AnalyticsWarning[]) => w.filter(x => x.code === 'overlap-exceeds-parent');

beforeEach(resetRowIndex);

describe('foldMapRows', () => {
  it('several concurrent overlaps and an interlude on one parent: only the concurrent ones come out', () => {
    const {folded, warnings} = fold([
      mapRow(300, {'1': 200}, {'2': 1}, 1),
      overlapRow('lunaria', 30, 1, {'1': 30}),
      overlapRow('carjack', 30, 1, {'1': 20}),
      overlapRow('lunaria', 30, 1, {'1': 5}),      // a second lunaria run
      overlapRow('arcana', 30, 1, {'1': 50}),      // interlude: never inside the parent
    ]);
    expect(folded).toHaveLength(1);
    const f = folded[0];
    expect(f.foldedOut.live).toBe(55);
    expect(f.ownIncome.live).toBe(145);
    expect(f.seasonalIncome.live).toBe(105);
    expect(f.bySeasonal.lunaria!.live).toBe(35);
    expect(f.bySeasonal.carjack!.live).toBe(20);
    expect(f.bySeasonal.arcana!.live).toBe(50);
    expect(f.cost.live).toBe(10);
    expect(f.net.live).toBe(145 + 105 - 10);
    expect(overlapWarnings(warnings)).toHaveLength(0);
  });

  it('sandlord: phase "map" folds, "hub" and null (legacy hub) do not', () => {
    const phase = (p: SeasonalPhase | null) => fold([
      mapRow(300, {'1': 100}, {}, 1),
      overlapRow('sandlord', 30, 1, {'1': 40}, p),
    ]).folded[0];
    expect(phase('map').ownIncome.live).toBe(60);
    expect(phase('map').foldedOut.live).toBe(40);
    expect(phase('hub').ownIncome.live).toBe(100);
    expect(phase('hub').foldedOut.live).toBe(0);
    expect(phase(null).ownIncome.live).toBe(100);
    // Either way the overlap's income is still the map's seasonal income.
    for (const p of ['map', 'hub', null] as const) expect(phase(p).seasonalIncome.live).toBe(40);
  });

  it('an orphan overlap (parent missing) is standalone: own 0, income to its mechanic, nothing folded, one warning', () => {
    const {folded, warnings} = fold([
      mapRow(100, {'1': 50}, {}, 1),
      overlapRow('lunaria', 30, 9, {'1': 40}),     // parent 9 does not exist
    ]);
    expect(folded.map(f => f.row.row.mapIndex)).toEqual([1, 9]);
    const map = folded[0], orphan = folded[1];
    expect(map.ownIncome.live).toBe(50);            // not reduced by the orphan
    expect(map.foldedOut.live).toBe(0);
    expect(orphan.row.kind).toBe('standalone-seasonal');
    expect(orphan.ownIncome.live).toBe(0);
    expect(orphan.bySeasonal.lunaria!.live).toBe(40);
    expect(orphan.net.live).toBe(40);
    expect(warnings.filter(w => w.code === 'orphan-overlap-row')).toEqual([{code: 'orphan-overlap-row', mapIndex: 9}]);
    expect(overlapWarnings(warnings)).toHaveLength(0);
  });

  it('an overlap whose parent is itself an overlap is an orphan, not folded into anything', () => {
    const {folded} = fold([
      mapRow(100, {'1': 50}, {}, 1),
      overlapRow('lunaria', 30, 1, {'1': 10}),
      makeRow({mapIndex: 5, parentMapIndex: 1, seasonalType: 'carjack', drops: {'1': 7}}),
      makeRow({mapIndex: 6, parentMapIndex: 5, seasonalType: 'dream', drops: {'1': 3}}), // parent 5 is not primary
    ]);
    expect(folded.map(f => f.row.row.mapIndex)).toEqual([1, 6]);
    expect(folded[1].row.kind).toBe('standalone-seasonal');
    expect(folded[0].foldedOut.live).toBe(17);
  });

  it.each([
    ['exclusive',    0],
    ['drop-through', 40],
    ['legacy',       40],
  ] as const)('era %s folds %i FE of concurrent overlap out of the parent', (era, folded) => {
    const f = fold([mapRow(300, {'1': 100}, {}, 1), overlapRow('lunaria', 30, 1, {'1': 40})], era).folded[0];
    expect(f.foldedOut.live).toBe(folded);
    expect(f.ownIncome.live).toBe(100 - folded);
    expect(f.seasonalIncome.live).toBe(40);
  });

  it('exclusive era never warns, even if the overlap is bigger than the parent', () => {
    const {warnings, folded} = fold([mapRow(300, {'1': 10}, {}, 1), overlapRow('lunaria', 30, 1, {'1': 400})], 'exclusive');
    expect(folded[0].ownIncome.live).toBe(10);
    expect(overlapWarnings(warnings)).toHaveLength(0);
  });

  it('a negative overlap income adds back to the parent (own = income - (-5)) and does not warn', () => {
    const {folded, warnings} = fold([mapRow(300, {'1': 100}, {}, 1), overlapRow('lunaria', 30, 1, {'1': -5})]);
    expect(folded[0].foldedOut.live).toBe(-5);
    expect(folded[0].ownIncome.live).toBe(105);
    expect(folded[0].seasonalIncome.live).toBe(-5);
    expect(folded[0].net.live).toBe(100);
    expect(overlapWarnings(warnings)).toHaveLength(0);
  });

  it('an overlap exactly equal to its parent leaves own 0 and no warning; float noise is tolerated', () => {
    expect(overlapWarnings(fold([mapRow(300, {'1': 40}, {}, 1), overlapRow('lunaria', 30, 1, {'1': 40})]).warnings)).toHaveLength(0);
    const noisy = fold([mapRow(300, {'1': 0.3}, {}, 1), overlapRow('lunaria', 30, 1, {'1': 0.30000000000000004})]);
    expect(overlapWarnings(noisy.warnings)).toHaveLength(0);
    // ...but a real excess, however small, warns.
    const over = fold([mapRow(300, {'1': 40}, {}, 1), overlapRow('lunaria', 30, 1, {'1': 41})]);
    expect(overlapWarnings(over.warnings)).toEqual([{code: 'overlap-exceeds-parent', mapIndex: 1}]);
    expect(over.folded[0].ownIncome.live).toBe(-1);
  });

  it('a standalone row is never folded and keeps its cost; its own map income is 0', () => {
    const {folded} = fold([standaloneRow('vorex', 60, {'1': 30}, {'2': 2}, 4)]);
    expect(folded[0].ownIncome.live).toBe(0);
    expect(folded[0].seasonalIncome.live).toBe(30);
    expect(folded[0].cost.live).toBe(20);
    expect(folded[0].net.live).toBe(10);
    expect(folded[0].foldedOut.live).toBe(0);
  });

  it('emits rows in input order (not mapIndex order), standalones interleaved with maps', () => {
    const {folded} = fold([
      standaloneRow('vorex', 10, {}, {}, 7),
      mapRow(60, {}, {}, 2),
      overlapRow('lunaria', 5, 2, {}),
      mapRow(60, {}, {}, 1),
    ]);
    expect(folded.map(f => f.row.row.mapIndex)).toEqual([7, 2, 1]);
  });

  it('warns on the snapshot leg alone, and exactly once', () => {
    // live: own = 10 - 10 = 0 ; snapshot ('2' priced 20): own = 10 - 20 = -10.
    const {warnings, folded} = fold(
      [mapRow(300, {'1': 10}, {}, 1), overlapRow('lunaria', 30, 1, {'2': 1})],
      'drop-through', {'2': 20, '1': 1},
    );
    expect(folded[0].ownIncome).toEqual({snapshot: -10, live: 0});
    expect(overlapWarnings(warnings)).toHaveLength(1);
  });
});

describe('duplicate primary rows sharing a mapIndex (continued sessions)', () => {
  const rows = () => [
    mapRow(100, {'1': 50}, {'2': 1}, 1),
    mapRow(100, {'1': 60}, {}, 1),
    overlapRow('lunaria', 30, 1, {'1': 10}),
  ];

  it('the fold counts an overlap once across the folded rows, on its resolved parent only', () => {
    const {folded, classified} = fold(rows());
    expect(folded.reduce((s, f) => s + f.seasonalIncome.live, 0)).toBe(10);
    expect(folded.reduce((s, f) => s + f.foldedOut.live, 0)).toBe(10);
    const parent = classified.find(c => c.kind === 'overlap-seasonal')!.parent;
    const owner  = folded.filter(f => f.seasonalIncome.live !== 0);
    expect(owner).toHaveLength(1);
    expect(owner[0].row.row).toBe(parent);
  });

  it('the map mechanic income and perMap net are right through a whole analytics pass', () => {
    const session = makeSession({
      attribution: 'drop-through', mapCount: 2,
      drops: {'1': 110}, dropsBySource: {map: {'1': 100}, lunaria: {'1': 10}}, spent: {'2': 1},
    });
    const a = computeSessionAnalytics({session, maps: rows(), items: ITEMS, tax: NO_TAX});
    // Own: 50 on the first, 60 - 10 on the second (the overlap's resolved parent).
    expect(a.mechanics.find(m => m.key === 'map')!.income.live).toBe(100);
    expect(a.mechanics.find(m => m.key === 'lunaria')!.income.live).toBe(10);
    expect(a.perMap.map(p => p.net.live)).toEqual([50 - 10, 50 + 10]);
    expect(a.perMap.reduce((s, p) => s + p.net.live, 0)).toBe(a.totals.net.live);
    expect(a.totals.net.live).toBe(100);
    expect(a.timeline.map(t => t.children.length)).toEqual([0, 1]);
    expect(overlapWarnings(a.meta.warnings)).toHaveLength(0);
  });
});

describe('the overlap-exceeds-parent warning across a whole analytics pass', () => {
  it('is emitted once per offending row, not once per consumer (mechanics, perMap, bySource)', () => {
    const session = makeSession({
      attribution: 'drop-through', mapCount: 3,
      drops: {'1': 30}, dropsBySource: {}, // legacy path too: it consumes the fold as well
    });
    const maps = [
      mapRow(300, {'1': 10}, {}, 1), overlapRow('lunaria', 30, 1, {'1': 25}),
      mapRow(300, {'1': 5},  {}, 2), overlapRow('carjack', 30, 2, {'1': 9}),
      mapRow(300, {'1': 50}, {}, 3), overlapRow('carjack', 30, 3, {'1': 9}),    // fine
    ];
    const a = computeSessionAnalytics({session, maps, items: ITEMS, tax: NO_TAX});
    expect(overlapWarnings(a.meta.warnings)).toEqual([
      {code: 'overlap-exceeds-parent', mapIndex: 1},
      {code: 'overlap-exceeds-parent', mapIndex: 2},
    ]);
  });

  it('a modern-path session (dropsBySource present) warns exactly as the legacy path does', () => {
    const maps = [mapRow(300, {'1': 10}, {}, 1), overlapRow('lunaria', 30, 1, {'1': 25})];
    const base = {attribution: 'drop-through' as const, mapCount: 1, drops: {'1': 10}};
    const legacy = computeSessionAnalytics({session: makeSession({...base, dropsBySource: {}}), maps, items: ITEMS, tax: NO_TAX});
    const modern = computeSessionAnalytics({session: makeSession({...base, dropsBySource: {map: {'1': -15}, lunaria: {'1': 25}}}), maps, items: ITEMS, tax: NO_TAX});
    expect(overlapWarnings(legacy.meta.warnings)).toHaveLength(1);
    expect(overlapWarnings(modern.meta.warnings)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Invariants on hand-built, internally consistent sessions
// ---------------------------------------------------------------------------

type Qty = Record<string, number>;
interface Run {
  /** What the map (or standalone) itself looted. */
  own?:   Qty;
  spent?: Qty;
  /** Overlaps: [seasonal, loot, phase]. */
  overlaps?: Array<[SeasonalType, Qty, SeasonalPhase?]>;
  /** A standalone seasonal run instead of a map. */
  standalone?: SeasonalType;
}

const add = (into: Qty, q: Qty) => { for (const [k, v] of Object.entries(q)) into[k] = (into[k] ?? 0) + v; };
const FREEZING: SeasonalType[] = ['arcana', 'vorex', 'tartarus'];
const concurrent = (t: SeasonalType, p?: SeasonalPhase) => (t === 'sandlord' ? p === 'map' : !FREEZING.includes(t));

/** Rows + session consistent with each other under the era's attribution rules
 *  (an independent oracle of the engine's bookkeeping) and per-source ownership. */
function build(runs: Run[], era: Attribution, snapshot: Record<string, number> = {}) {
  const contains = era !== 'exclusive';
  const rows: DbSessionMap[] = [];
  const drops: Qty = {}, spent: Qty = {};
  const bySource: Record<string, Qty> = {};
  const own = (source: string, q: Qty) => { bySource[source] ??= {}; add(bySource[source], q); };
  let idx = 0, maps = 0;
  for (const run of runs) {
    idx += 1;
    if (run.standalone) {
      rows.push(standaloneRow(run.standalone, 60, run.own ?? {}, run.spent ?? {}, idx));
      add(drops, run.own ?? {}); add(spent, run.spent ?? {}); own(run.standalone, run.own ?? {});
      continue;
    }
    maps += 1;
    const parent: Qty = {...(run.own ?? {})};
    const overlapRows: DbSessionMap[] = [];
    for (const [t, q, p] of run.overlaps ?? []) {
      overlapRows.push(overlapRow(t, 30, idx, q, p ?? null));
      own(t, q);
      add(drops, q);                                   // every overlap's loot is session loot...
      if (contains && concurrent(t, p)) add(parent, q); // ...and a drop-through parent holds it too
    }
    rows.push(mapRow(300, parent, run.spent ?? {}, idx), ...overlapRows);
    // The session counts the parent's OWN loot; the overlaps were added above.
    add(drops, run.own ?? {});
    add(spent, run.spent ?? {});
    own('map', run.own ?? {});
  }
  const session = makeSession({
    attribution: era, mapCount: maps, drops, spent, dropsBySource: bySource, priceSnapshot: snapshot,
    totalTime: 100_000, mapTime: 1000,
  });
  return {session, rows};
}

const SCENARIOS: Record<string, Run[]> = {
  'plain maps with cost': [
    {own: {'1': 100}, spent: {'2': 1}},
    {own: {'1': 40, '3': 3}, spent: {'2': 2, '3': 1}},
  ],
  'concurrent + interlude + sandlord phases': [
    {own: {'1': 100, '2': -3}, spent: {'2': 1}, overlaps: [
      ['lunaria', {'1': 30, '3': 7}], ['carjack', {'1': 11}], ['arcana', {'2': 2}],
      ['sandlord', {'1': 6}, 'map'], ['sandlord', {'3': 4}, 'hub'], ['sandlord', {'1': 1}],
    ]},
    {own: {'1': 8}, overlaps: [['vorex', {'1': 12}]]},
  ],
  'negative map (net consumption) and a standalone': [
    {own: {'1': -20, '2': 1}, spent: {'1': 5}, overlaps: [['carjack', {'1': 5}]]},
    {standalone: 'vorex', own: {'1': 9, '2': -1}, spent: {'2': 1}},
    {own: {'3': 6}, spent: {'1': 6}},
  ],
  'item both spent and looted, with a fuel-only loop': [
    {own: {'1': 100}, spent: {'1': 20}},
    {own: {'3': 50}, spent: {'3': 50}, overlaps: [['hunting', {'3': 10}]]},
  ],
  'only interlude overlaps': [
    {own: {}, overlaps: [['arcana', {'1': 5}], ['vorex', {'2': 1}]]},
  ],
};

const ERAS: Attribution[] = ['exclusive', 'drop-through', 'legacy'];
const SNAPSHOTS: Array<[string, Record<string, number>]> = [['no snapshot', {}], ['a differing snapshot', {'1': 2, '2': 7, '3': 9}]];
const TAXES: Array<[string, TaxConfig]> = [['untaxed', NO_TAX], ['taxed', TAX_ON]];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const LEGS = ['live', 'snapshot'] as const;

describe.each(Object.entries(SCENARIOS))('invariants: %s', (_name, runs) => {
  describe.each(ERAS)('era %s', era => {
    describe.each(SNAPSHOTS)('%s', (_s, snapshot) => {
      describe.each(TAXES)('%s', (_t, tax) => {
        const {session, rows} = build(runs, era, snapshot);
        const a: SessionAnalytics = computeSessionAnalytics({session, maps: rows, items: ITEMS, tax});

        it('sum of mechanics net = sum of perMap net = totals.net (both legs)', () => {
          for (const leg of LEGS) {
            expect(sum(a.mechanics.map(m => m.net[leg]))).toBeCloseTo(a.totals.net[leg], 6);
            expect(sum(a.perMap.map(p => p.net[leg]))).toBeCloseTo(a.totals.net[leg], 6);
          }
        });

        it('totals.cost = valued session.spent = consumed grand total; net = income - cost', () => {
          for (const leg of LEGS) {
            expect(sum(a.consumed.map(c => c.total[leg]))).toBeCloseTo(a.totals.cost[leg], 6);
            expect(a.totals.net[leg]).toBeCloseTo(a.totals.income[leg] - a.totals.cost[leg], 9);
          }
        });

        it('bySource slices (modern path) re-add to session income; negatives keep sign with pct 0', () => {
          expect(a.meta.legacyBySource).toBe(false);
          for (const leg of LEGS) {
            expect(sum(a.bySource.map(s => s.value[leg]))).toBeCloseTo(a.totals.income[leg], 6);
            for (const s of a.bySource) if (s.value[leg] < 0) expect(s.pct[leg]).toBe(0);
            if (a.bySource.some(s => s.value[leg] > 0)) expect(sum(a.bySource.map(s => s.pct[leg]))).toBeCloseTo(100, 6);
          }
        });

        it('bySource on the legacy path (no dropsBySource) also re-adds to session income', () => {
          const legacy = computeSessionAnalytics({session: {...session, dropsBySource: {}}, maps: rows, items: ITEMS, tax});
          expect(legacy.meta.legacyBySource).toBe(true);
          for (const leg of LEGS) {
            expect(sum(legacy.bySource.map(s => s.value[leg]))).toBeCloseTo(legacy.totals.income[leg], 6);
          }
        });

        it('byType slices re-add to session income; shares sum to 100 over positive slices; negatives have pct 0', () => {
          for (const leg of LEGS) {
            expect(sum(a.byType.map(t => t.value[leg]))).toBeCloseTo(a.totals.income[leg], 6);
            for (const t of a.byType) if (t.value[leg] < 0) expect(t.pct[leg]).toBe(0);
            if (a.byType.some(t => t.value[leg] > 0)) expect(sum(a.byType.map(t => t.pct[leg]))).toBeCloseTo(100, 6);
          }
        });

        it('the map mechanic owns the same income as perMap, and every figure is finite', () => {
          const mapMech = a.mechanics.find(m => m.key === 'map');
          if (mapMech) {
            expect(mapMech.income.live).toBeCloseTo(sum(a.perMap.filter(p => p.mechanic === 'map').map(p => p.mapIncome.live)), 6);
          }
          for (const m of a.mechanics) {
            expect(Number.isFinite(m.net.live) && Number.isFinite(m.fePerHour.live) && Number.isFinite(m.valuePct.live)).toBe(true);
          }
        });
      });
    });
  });
});

describe('hasSnapshot / coveredIds through the analytics pass', () => {
  const analyze = (session: DbSession, maps: DbSessionMap[] = []) =>
    computeSessionAnalytics({session, maps, items: ITEMS, tax: NO_TAX});

  it('a snapshot covering only a spent id counts, and the snapshot leg prices the spent side from it', () => {
    const a = analyze(makeSession({drops: {'1': 10}, spent: {'2': 1}, priceSnapshot: {'2': 30}}));
    expect(a.meta.hasSnapshot).toBe(true);
    expect(a.totals.cost).toEqual({snapshot: 30, live: 10});
    // '1' is absent from the snapshot: that item falls back to live, never to 0.
    expect(a.totals.income).toEqual({snapshot: 10, live: 10});
    expect(a.totals.net).toEqual({snapshot: -20, live: 0});
  });

  it('a snapshot covering only a looted id counts, and spent items missing from it fall back to live', () => {
    const a = analyze(makeSession({drops: {'1': 10}, spent: {'2': 1}, priceSnapshot: {'1': 3}}));
    expect(a.meta.hasSnapshot).toBe(true);
    expect(a.totals.income).toEqual({snapshot: 30, live: 10});
    expect(a.totals.cost).toEqual({snapshot: 10, live: 10});
  });

  it('a snapshot covering neither drops nor spent is absent: both legs alias, no drift', () => {
    const a = analyze(makeSession({drops: {'1': 10}, spent: {'2': 1}, priceSnapshot: {'3': 99}}));
    expect(a.meta.hasSnapshot).toBe(false);
    expect(a.totals.net.snapshot).toBe(a.totals.net.live);
    expect(a.totals.driftPct).toBeNull();
  });

  it('a snapshot on a session with nothing dropped or spent does not count', () => {
    expect(analyze(makeSession({priceSnapshot: {'1': 5}})).meta.hasSnapshot).toBe(false);
  });

  it('a spent id at zero quantity still counts as covered (the key exists)', () => {
    const a = analyze(makeSession({drops: {}, spent: {'2': 0}, priceSnapshot: {'2': 30}}));
    expect(a.meta.hasSnapshot).toBe(true);
  });
});
