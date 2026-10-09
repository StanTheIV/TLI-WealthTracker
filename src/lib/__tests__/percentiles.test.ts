import {describe, it, expect} from 'vitest';
import {median, percentile} from '@/lib/percentiles';

describe('median', () => {
  it('handles odd, even, single and unsorted input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([40, 10, 30, 20])).toBe(25);
    expect(median([42.5])).toBe(42.5);
  });
  it('does not mutate input', () => {
    const v = [3, 1, 2];
    median(v);
    expect(v).toEqual([3, 1, 2]);
  });
  it('returns NaN for empty input', () => {
    expect(median([])).toBeNaN();
  });
});

describe('percentile', () => {
  const v = [10, 20, 30, 40, 50];
  it('hits endpoints and exact ranks', () => {
    expect(percentile(v, 0)).toBe(10);
    expect(percentile(v, 1)).toBe(50);
    expect(percentile(v, 0.5)).toBe(30);
    expect(percentile(v, 0.25)).toBe(20);
  });
  it('interpolates linearly between ranks', () => {
    expect(percentile(v, 0.1)).toBeCloseTo(14);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
  it('clamps q and handles single element', () => {
    expect(percentile(v, -1)).toBe(10);
    expect(percentile(v, 2)).toBe(50);
    expect(percentile([7], 0.9)).toBe(7);
  });
  it('returns NaN for empty input', () => {
    expect(percentile([], 0.5)).toBeNaN();
  });
});
