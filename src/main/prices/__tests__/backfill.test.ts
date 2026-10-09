import {describe, expect, it} from 'vitest';
import {extractBackfillPoints} from '../history';

const bd = (o: Record<string, number>) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, p]) => [k, {qty: 1, price: p, total: p}])));

describe('extractBackfillPoints', () => {
  it('merges wealth breakdowns and session snapshots, keeping only change-points per item', () => {
    const pts = extractBackfillPoints(
      [
        {timestamp: 1000, breakdown: bd({a: 1, b: 5})},
        {timestamp: 2000, breakdown: bd({a: 1, b: 6})},
        {timestamp: 4000, breakdown: bd({a: 2})},
      ],
      [{saved_at: new Date(3000).toISOString(), price_snapshot: JSON.stringify({a: 1, b: 6})}],
    );
    expect(pts.filter(p => p.itemId === 'a')).toEqual([
      {itemId: 'a', timestamp: 1000, price: 1},
      {itemId: 'a', timestamp: 4000, price: 2},
    ]);
    expect(pts.filter(p => p.itemId === 'b').map(p => p.timestamp)).toEqual([1000, 2000]);
  });

  it('skips malformed JSON, bad dates, non-numeric and non-positive prices', () => {
    const pts = extractBackfillPoints(
      [
        {timestamp: 1, breakdown: '{not json'},
        {timestamp: 2, breakdown: '[1,2]'},
        {timestamp: NaN, breakdown: bd({a: 1})},
        {timestamp: 3, breakdown: JSON.stringify({a: null, b: {price: 'x'}, c: {price: 0}, d: {price: 7}})},
      ],
      [
        {saved_at: 'garbage', price_snapshot: JSON.stringify({a: 9})},
        {saved_at: new Date(5).toISOString(), price_snapshot: 'oops'},
      ],
    );
    expect(pts).toEqual([{itemId: 'd', timestamp: 3, price: 7}]);
  });
});
