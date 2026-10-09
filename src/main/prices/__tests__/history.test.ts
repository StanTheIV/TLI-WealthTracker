import {describe, expect, it} from 'vitest';
import {
  bucket,
  compressChangePoints,
  pickBucketMs,
  shouldSkipDuplicate,
  summarize,
} from '../history';

describe('summarize', () => {
  it('computes n, min and interpolated percentiles on unsorted input without mutating it', () => {
    const input = [5, 1, 3, 2, 4];
    const s = summarize(input);
    expect(input).toEqual([5, 1, 3, 2, 4]);
    expect(s).toEqual({n: 5, min: 1, p10: 1.4, p25: 2, p75: 4, p90: 4.6});
  });

  it('handles a single listing and empty input', () => {
    expect(summarize([7])).toEqual({n: 1, min: 7, p10: 7, p25: 7, p75: 7, p90: 7});
    expect(summarize([]).n).toBe(0);
  });
});

describe('shouldSkipDuplicate', () => {
  const last = {timestamp: 1_000_000, price: 1.5, n: 40};
  it('skips same median and n inside the window', () => {
    expect(shouldSkipDuplicate(last, {timestamp: 1_060_000, price: 1.5, n: 40})).toBe(true);
    expect(shouldSkipDuplicate(last, {timestamp: 1_120_000, price: 1.5, n: 40})).toBe(true);
  });
  it('keeps when outside the window, or median/n differ, or no previous', () => {
    expect(shouldSkipDuplicate(last, {timestamp: 1_120_001, price: 1.5, n: 40})).toBe(false);
    expect(shouldSkipDuplicate(last, {timestamp: 1_010_000, price: 1.6, n: 40})).toBe(false);
    expect(shouldSkipDuplicate(last, {timestamp: 1_010_000, price: 1.5, n: 41})).toBe(false);
    expect(shouldSkipDuplicate(undefined, {timestamp: 1, price: 1, n: 1})).toBe(false);
  });
  it('treats null n (manual) as equal to null n', () => {
    const m = {timestamp: 0, price: 2, n: null};
    expect(shouldSkipDuplicate(m, {timestamp: 1000, price: 2, n: null})).toBe(true);
  });
  it('honours a custom window', () => {
    expect(shouldSkipDuplicate(last, {timestamp: 1_030_000, price: 1.5, n: 40}, 10_000)).toBe(false);
  });
});

describe('compressChangePoints', () => {
  it('keeps the first point per item and only subsequent changes', () => {
    const out = compressChangePoints([
      {itemId: 'b', timestamp: 3, price: 2},
      {itemId: 'a', timestamp: 2, price: 1},
      {itemId: 'a', timestamp: 1, price: 1},
      {itemId: 'a', timestamp: 3, price: 2},
      {itemId: 'a', timestamp: 4, price: 2},
      {itemId: 'a', timestamp: 5, price: 1},
      {itemId: 'b', timestamp: 1, price: 2},
    ]);
    expect(out).toEqual([
      {itemId: 'a', timestamp: 1, price: 1},
      {itemId: 'a', timestamp: 3, price: 2},
      {itemId: 'a', timestamp: 5, price: 1},
      {itemId: 'b', timestamp: 1, price: 2},
    ]);
  });

  it('ignores non-positive and non-finite prices', () => {
    const out = compressChangePoints([
      {itemId: 'a', timestamp: 1, price: 0},
      {itemId: 'a', timestamp: 2, price: -1},
      {itemId: 'a', timestamp: 3, price: NaN},
      {itemId: 'a', timestamp: 4, price: Infinity},
      {itemId: 'a', timestamp: 5, price: 3},
    ]);
    expect(out).toEqual([{itemId: 'a', timestamp: 5, price: 3}]);
  });
});

describe('bucket', () => {
  const H = 3_600_000;
  const obs = (id: number, timestamp: number, price: number, source = 'scrape') => ({
    id,
    timestamp,
    price,
    source,
  });

  it('recomputes percentiles from merged listings, not by averaging per-search percentiles', () => {
    // Search 1: 1..4 (median 2.5), search 2: a single 100 (median 100).
    const listings = new Map([
      [1, [1, 2, 3, 4]],
      [2, [100]],
    ]);
    const [b] = bucket([obs(1, 0, 2.5), obs(2, 10, 100)], listings, H);
    // merged = [1,2,3,4,100]
    expect(b.n).toBe(5);
    expect(b.searches).toBe(2);
    expect(b.median).toBe(3);
    expect(b.p25).toBe(2);
    expect(b.p75).toBe(4);
    expect(b.p10).toBeCloseTo(1.4);
    expect(b.p90).toBeCloseTo(61.6);
    // Averaging would give median (2.5+100)/2 = 51.25, p25 = (1.75+100)/2, ...
    expect(b.median).not.toBe((2.5 + 100) / 2);
  });

  it('omits empty buckets and orders by time, aligning to bucket start', () => {
    const listings = new Map([
      [1, [1]],
      [2, [2]],
    ]);
    const out = bucket([obs(2, 5 * H + 5, 2), obs(1, 100, 1)], listings, H);
    expect(out.map(b => b.timestamp)).toEqual([0, 5 * H]);
  });

  it('reports manual points separately and ignores them for the median when listings exist', () => {
    const listings = new Map([[1, [10, 20, 30]]]);
    const [b] = bucket([obs(1, 0, 20), obs(2, 50, 999, 'manual')], listings, H);
    expect(b.median).toBe(20);
    expect(b.manual).toEqual([{timestamp: 50, price: 999, source: 'manual'}]);
  });

  it('uses the median of manual prices when a bucket has no listings', () => {
    const [b] = bucket(
      [obs(1, 0, 4, 'manual'), obs(2, 10, 8, 'backfill'), obs(3, 20, 6, 'manual')],
      new Map(),
      H,
    );
    expect(b.median).toBe(6);
    expect(b.n).toBe(0);
    expect(b.searches).toBe(0);
    expect(b.p25).toBeNull();
    expect(b.manual).toHaveLength(3);
  });

  it('bucketMs 0 yields one point per distinct timestamp', () => {
    const listings = new Map([
      [1, [1, 3]],
      [2, [5]],
    ]);
    const out = bucket([obs(1, 10, 2), obs(2, 11, 5)], listings, 0);
    expect(out.map(b => b.timestamp)).toEqual([10, 11]);
    expect(out[0].median).toBe(2);
  });

  it('returns [] for no observations', () => {
    expect(bucket([], new Map(), H)).toEqual([]);
  });
});

describe('pickBucketMs', () => {
  const DAY = 24 * 3_600_000;
  it('is raw under 200 observations', () => {
    expect(pickBucketMs(199, 100 * DAY)).toBe(0);
  });
  it('is hourly up to 14 days, daily beyond', () => {
    expect(pickBucketMs(200, 14 * DAY)).toBe(3_600_000);
    expect(pickBucketMs(5000, 14 * DAY + 1)).toBe(DAY);
  });
});
