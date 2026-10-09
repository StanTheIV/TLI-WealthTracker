import {describe, expect, it} from 'vitest';
import type {PriceBucket} from '@/main/prices/history';
import {leagueRanges} from '../leagues';
import {buildChartRows, csvField, formatPrice, toCsv} from '../priceChart';

const bucket = (timestamp: number, median: number, extra: Partial<PriceBucket> = {}): PriceBucket => ({
  timestamp, median, p10: median / 2, p25: median * 0.8, p75: median * 1.2, p90: median * 2,
  n: 10, searches: 1, manual: [], ...extra,
});

const ranges = leagueRanges([
  {id: 'A', name: 'A', startsAt: 0, source: 'bundled'},
  {id: 'B', name: 'B', startsAt: 100, source: 'bundled'},
]);

describe('buildChartRows', () => {
  it('inserts a null gap row just before a league start inside the range', () => {
    const rows = buildChartRows([bucket(50, 1), bucket(150, 2)], ranges, 10, 200, false);
    expect(rows.map(r => [r.t, r.gap, r.median])).toEqual([[50, false, 1], [99, true, null], [150, false, 2]]);
  });
  it('does not add gaps for boundaries at or outside the range edges', () => {
    const rows = buildChartRows([bucket(150, 2)], ranges, 100, 200, false);
    expect(rows.every(r => !r.gap)).toBe(true);
  });
  it('builds range tuples and nulls them when a percentile is missing', () => {
    const [r] = buildChartRows([bucket(5, 10, {p25: null})], ranges, 0, 200, false);
    expect(r.outer).toEqual([5, 20]);
    expect(r.iqr).toBeNull();
  });
  it('keeps listing-less (backfill/manual) buckets on the median line without bands', () => {
    const rows = buildChartRows(
      [bucket(5, 3, {n: 0, p10: null, p25: null, p75: null, p90: null})], ranges, 0, 200, false,
    );
    const real = rows.filter(r => !r.gap);
    expect(real).toHaveLength(1);
    expect(real[0].median).toBe(3);
    expect(real[0].iqr).toBeNull();
    expect(real[0].outer).toBeNull();
  });
  it('drops non-positive values in log mode', () => {
    const [r] = buildChartRows([bucket(5, 10, {p10: 0})], ranges, 0, 200, true);
    expect(r.p10).toBeNull();
    expect(r.outer).toBeNull();
    expect(r.median).toBe(10);
    expect(buildChartRows([bucket(5, 0)], ranges, 0, 200, true)[0].median).toBeNull();
  });
});

describe('formatPrice', () => {
  // Locale-independent: compare against the runtime's own decimal separator.
  const dec = (1.5).toLocaleString().charAt(1);
  it('keeps precision for sub-1 prices', () => {
    expect(formatPrice(0.0015)).toBe(`0${dec}0015`);
    expect(formatPrice(0.0387)).toBe(`0${dec}039`);
  });
  it('compacts large values', () => {
    expect(formatPrice(1500)).toBe(`1${dec}5k`);
    expect(formatPrice(2_500_000)).toBe(`2${dec}5M`);
  });
  it('uses the same decimal separator below and above 1', () => {
    expect(formatPrice(0.5)).toBe(`0${dec}5`);
    expect(formatPrice(2.51)).toBe(`2${dec}51`);
  });
});

describe('csv', () => {
  it('escapes commas, quotes and newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('x\ny')).toBe('"x\ny"');
    expect(csvField(null)).toBe('');
    expect(csvField(0.5)).toBe('0.5');
  });
  it('emits header and ISO rows', () => {
    const csv = toCsv([{
      timestamp: 0, itemId: '100200', name: 'Flame, "Elementium"', source: 'scrape',
      price: 1.5, n: 40, p10: 1, p25: 1.2, p75: 2, p90: 3, min: 0.9,
    }, {
      timestamp: 1000, itemId: '1', name: 'X', source: 'manual',
      price: 2, n: null, p10: null, p25: null, p75: null, p90: null, min: null,
    }]);
    expect(csv.split('\r\n')).toEqual([
      'timestamp,item_id,name,source,price,n,p10,p25,p75,p90,min',
      '1970-01-01T00:00:00.000Z,100200,"Flame, ""Elementium""",scrape,1.5,40,1,1.2,2,3,0.9',
      '1970-01-01T00:00:01.000Z,1,X,manual,2,,,,,,',
      '',
    ]);
  });
});
