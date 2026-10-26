import type {FoldedRow, HistogramBucket, MapNetStats, PerMapPoint} from './types';
import {ZERO_VAL, addVal, scaleVal} from '@/domain/valuation';

const HISTOGRAM_BUCKETS = 12;

/** One point per PRIMARY row, in run order, straight off the fold. Bucketing
 *  for a fixed-width chart is a display concern and stays in the component. */
export function computePerMap(folded: FoldedRow[]): PerMapPoint[] {
  let cumulative = ZERO_VAL;
  return folded.map(f => {
    cumulative = addVal(cumulative, f.net);
    return {
      mapIndex:       f.row.row.mapIndex,
      mechanic:       f.row.mechanic,
      seconds:        f.row.seconds,
      mapIncome:      f.ownIncome,
      seasonalIncome: f.seasonalIncome,
      bySeasonal:     f.bySeasonal,
      cost:           f.cost,
      net:            f.net,
      cumulative,
    };
  });
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
