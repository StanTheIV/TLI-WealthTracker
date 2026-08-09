import type {DbSession} from '@/types/electron';
import type {
  ClassifiedRow, HistogramBucket, MapNetStats, MechanicKey, PerMapPoint, Valuation,
} from './types';
import {parentContainsOverlap} from './attribution';
import {ZERO_VAL, addVal, clampVal, scaleVal, subVal} from './valuation';

const HISTOGRAM_BUCKETS = 12;

/** One point per PRIMARY row, in run order. Bucketing for a fixed-width chart
 *  is a display concern and stays in the component. */
export function computePerMap(session: DbSession, classified: ClassifiedRow[]): PerMapPoint[] {
  const fold = parentContainsOverlap(session.attribution);

  const overlapsByParent = new Map<number, ClassifiedRow[]>();
  const foldable = new Map<number, Valuation>();
  for (const c of classified) {
    if (c.kind !== 'overlap-seasonal' || c.parent === null) continue;
    const list = overlapsByParent.get(c.parent.mapIndex) ?? [];
    list.push(c);
    overlapsByParent.set(c.parent.mapIndex, list);
    // Only concurrent overlaps dropped through into the parent, so only they
    // can be folded back out of it. See computeMechanics.
    if (c.concurrentWithMap) {
      foldable.set(c.parent.mapIndex, addVal(foldable.get(c.parent.mapIndex) ?? ZERO_VAL, c.income));
    }
  }

  let cumulative = ZERO_VAL;
  const out: PerMapPoint[] = [];

  for (const c of classified) {
    if (c.kind === 'overlap-seasonal') continue;

    const overlaps = overlapsByParent.get(c.row.mapIndex) ?? [];
    const bySeasonal: Partial<Record<MechanicKey, Valuation>> = {};
    let seasonalIncome = ZERO_VAL;
    for (const o of overlaps) {
      bySeasonal[o.mechanic] = addVal(bySeasonal[o.mechanic] ?? ZERO_VAL, o.income);
      seasonalIncome = addVal(seasonalIncome, o.income);
    }

    let mapIncome: Valuation;
    if (c.kind === 'standalone-seasonal') {
      // The whole row belongs to its mechanic, not to a map.
      bySeasonal[c.mechanic] = addVal(bySeasonal[c.mechanic] ?? ZERO_VAL, c.income);
      seasonalIncome = addVal(seasonalIncome, c.income);
      mapIncome = ZERO_VAL;
    } else {
      const foldOut = foldable.get(c.row.mapIndex) ?? ZERO_VAL;
      mapIncome = fold ? clampVal(subVal(c.income, foldOut)) : c.income;
    }

    const net = subVal(addVal(mapIncome, seasonalIncome), c.cost);
    cumulative = addVal(cumulative, net);

    out.push({
      mapIndex: c.row.mapIndex,
      mechanic: c.mechanic,
      seconds:  c.seconds,
      mapIncome,
      seasonalIncome,
      bySeasonal,
      cost: c.cost,
      net,
      cumulative,
    });
  }

  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function histogram(values: number[]): HistogramBucket[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (max - min < 1e-9) {
    return [{from: min, to: max, count: values.length}];
  }

  const width   = (max - min) / HISTOGRAM_BUCKETS;
  const buckets: HistogramBucket[] = Array.from({length: HISTOGRAM_BUCKETS}, (_, i) => ({
    from:  min + i * width,
    to:    min + (i + 1) * width,
    count: 0,
  }));

  for (const v of values) {
    // The maximum value lands exactly one past the last bucket without a clamp.
    const idx = Math.min(HISTOGRAM_BUCKETS - 1, Math.floor((v - min) / width));
    buckets[idx].count += 1;
  }
  return buckets;
}

/** Spread of per-run net value. Median and mean are computed per valuation leg
 *  independently — sorting by one leg and reading the other off that index
 *  would mislabel the figure. */
export function computeMapNetStats(perMap: PerMapPoint[]): MapNetStats {
  if (perMap.length === 0) {
    return {mean: ZERO_VAL, median: ZERO_VAL, best: null, worst: null, histogram: []};
  }

  const live     = perMap.map(p => p.net.live);
  const snapshot = perMap.map(p => p.net.snapshot);
  const total    = perMap.reduce((acc, p) => addVal(acc, p.net), ZERO_VAL);

  let best  = perMap[0];
  let worst = perMap[0];
  for (const p of perMap) {
    if (p.net.live > best.net.live)  best = p;
    if (p.net.live < worst.net.live) worst = p;
  }

  return {
    mean:   scaleVal(total, 1 / perMap.length),
    median: {snapshot: median(snapshot), live: median(live)},
    best:   {mapIndex: best.mapIndex, net: best.net},
    worst:  {mapIndex: worst.mapIndex, net: worst.net},
    histogram: histogram(live),
  };
}
