/**
 * Median of a list (does not mutate the input). Averages the two middle
 * values for even counts. Empty input returns NaN.
 */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Percentile of an ascending-sorted list using linear interpolation between
 * the closest ranks (the "R-7" method, same as Excel PERCENTILE.INC / numpy
 * default). `q` is in [0, 1] and is clamped. Empty input returns NaN.
 * The caller is responsible for sorting; the input is not copied or checked.
 */
export function percentile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const clamped = Math.min(1, Math.max(0, q));
  const pos = clamped * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
