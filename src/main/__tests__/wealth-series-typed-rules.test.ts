/** 5.1b: WealthSeries consumes typed rules — no parse, no unreadable-rules fallback. */
import {describe, it, expect, vi} from 'vitest';
import {WealthSeries} from '@/main/wealth-series';
import type {ItemFilter, FilterRule} from '@/shared/item-filter';

type Deps = ConstructorParameters<typeof WealthSeries>[0];

const hideEmber: FilterRule = {id: 'r', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['wealth']};
const row = {id: 1, timestamp: 5, value: 20, breakdown: '{"100":{"qty":2,"price":10,"total":20}}'};

function build(getAll: () => ItemFilter[]) {
  const log = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const ws = new WealthSeries({
    points:   {heads: () => [{id: 1, timestamp: 5, value: 20}], range: () => [row], latest: () => [row]},
    items:    {getAll: () => [{id: '100', name: 'Ember', type: 'Remembrance Material', price: 10, priceDate: 1}]},
    filters:  {getAll},
    settings: {getAll: () => ({auctionTaxEnabled: 'false'})},
    log,
  } as unknown as Deps);
  return {ws, log};
}

describe('WealthSeries — typed rules', () => {
  it('applies the enabled filter rules as typed', () => {
    const {ws} = build(() => [{id: 'f', name: 'f', enabled: true, rules: [hideEmber]}]);
    expect(ws.latestBreakdown()?.value).toBe(0);
  });

  it('no enabled filter gives the unfiltered value', () => {
    const {ws} = build(() => [{id: 'f', name: 'f', enabled: false, rules: [hideEmber]}]);
    expect(ws.latestBreakdown()?.value).toBe(20);
  });

  it('a throwing filters.getAll propagates from series and latestBreakdown', () => {
    const {ws, log} = build(() => { throw new Error('Filter f: corrupt rules'); });
    expect(() => ws.series(0, 100)).toThrow(/corrupt rules/);
    expect(() => ws.latestBreakdown()).toThrow(/corrupt rules/);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('the legacy string-rules fallback is gone: no warn, no silent unfiltered value', () => {
    const {ws, log} = build(() => [{id: 'f', name: 'f', enabled: true, rules: '{nope' as unknown as FilterRule[]}]);
    let value: number | undefined;
    try { value = ws.latestBreakdown()?.value; } catch { /* a throw is acceptable too */ }
    expect(log.warn).not.toHaveBeenCalled();
    expect(value).not.toBe(20);
  });
});
