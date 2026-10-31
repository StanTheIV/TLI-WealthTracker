/** A stored breakdown whose shape is wrong is unparseable as a whole: the
 *  point shows its stored value and has no rows (brief 4.5, Decisions) — it
 *  never throws inside the valuation and so never kills a whole series. */
import {describe, it, expect} from 'vitest';
import {AUCTION_TAX_RATE, NO_TAX} from '@/domain/valuation';
import {
  compactPointValue, compactWealthPoint, parseWealthBreakdown, wealthBreakdownRows, wealthPointValue,
  type WealthValuation,
} from '..';

const untaxed: WealthValuation = {tax: NO_TAX, rawTypeOf: () => undefined, rules: []};
const taxed:   WealthValuation = {tax: {enabled: true, rate: AUCTION_TAX_RATE}, rawTypeOf: () => undefined, rules: []};

const OK = '{"qty":2,"price":3,"total":6}';

describe('malformed breakdown entries make the whole breakdown unparseable', () => {
  it.each([
    ['a null entry',                  '{"1":null}'],
    ['a number entry',                '{"1":5}'],
    ['a string entry',                '{"1":"x"}'],
    ['a boolean entry',               '{"1":true}'],
    ['an array entry',                '{"1":[2,3]}'],
    ['an empty array entry',          '{"1":[]}'],
    ['an empty object entry',         '{"1":{}}'],
    ['a missing qty',                 '{"1":{"price":3,"total":6}}'],
    ['a missing price',               '{"1":{"qty":2,"total":6}}'],
    ['a string qty',                  '{"1":{"qty":"2","price":3,"total":6}}'],
    ['a string price',                '{"1":{"qty":2,"price":"3","total":6}}'],
    ['a null qty',                    '{"1":{"qty":null,"price":3,"total":6}}'],
    ['a null price',                  '{"1":{"qty":2,"price":null,"total":6}}'],
    ['an infinite qty (1e999)',       '{"1":{"qty":1e999,"price":3,"total":6}}'],
    ['an infinite price (-1e999)',    '{"1":{"qty":2,"price":-1e999,"total":6}}'],
    ['an object qty',                 '{"1":{"qty":{"n":2},"price":3,"total":6}}'],
    ['a valid entry, then a null',    `{"1":${OK},"2":null}`],
    ['a null, then a valid entry',    `{"1":null,"2":${OK}}`],
    ['valid entries around an array', `{"1":${OK},"2":[1],"3":${OK}}`],
    ['valid, then a string price',    `{"1":${OK},"2":{"qty":1,"price":"9","total":9}}`],
    ['an own __proto__ that is null', `{"__proto__":null,"1":${OK}}`],
  ])('%s: null, the stored value, no rows, nothing throws', (_name, json) => {
    const bd = parseWealthBreakdown(json);
    expect(bd).toBeNull();
    for (const v of [untaxed, taxed]) {
      expect(wealthPointValue(5, bd, v)).toBe(5);
      expect(wealthBreakdownRows(bd, v)).toEqual([]);
      expect(compactPointValue(compactWealthPoint(5, bd), v)).toBe(5);
    }
  });
});

describe('a prototype-named raw item type', () => {
  it.each(['constructor', 'toString', '__proto__'])('%s counts as other for by-type rules and the tax', raw => {
    const bd = parseWealthBreakdown(OK.replace(/^/, '{"1":') + '}');
    const rawTypeOf = (id: string) => (id === '1' ? raw : undefined);
    const hideOther: WealthValuation = {
      tax: NO_TAX, rawTypeOf,
      rules: [{id: 'r', action: 'hide', scopes: ['wealth'], kind: {type: 'by-type', itemType: 'other'}}],
    };
    expect(wealthPointValue(6, bd, hideOther)).toBe(0);
    expect(wealthBreakdownRows(bd, hideOther)).toEqual([]);
    expect(wealthPointValue(6, bd, {...taxed, rawTypeOf})).toBeCloseTo(6 * (1 - AUCTION_TAX_RATE), 9);
  });
});

describe('well-formed entries', () => {
  it('total is optional and never validated (it is never read back)', () => {
    for (const json of ['{"1":{"qty":2,"price":3}}', '{"1":{"qty":2,"price":3,"total":"x"}}', '{"1":{"qty":2,"price":3,"total":null}}']) {
      const bd = parseWealthBreakdown(json);
      expect(bd, json).not.toBeNull();
      expect(wealthPointValue(999, bd, untaxed), json).toBe(6);
      expect(wealthBreakdownRows(bd, untaxed), json).toEqual([{id: '1', qty: 2, unitPrice: 3, total: 6}]);
    }
  });

  it('extra fields on an entry are ignored', () => {
    const bd = parseWealthBreakdown('{"1":{"qty":2,"price":3,"total":6,"name":"x"}}');
    expect(wealthPointValue(0, bd, untaxed)).toBe(6);
  });

  it('zero and negative qty / price are well-formed (the qty <= 0 rule drops the item, not the breakdown)', () => {
    const bd = parseWealthBreakdown(`{"1":{"qty":0,"price":3},"2":{"qty":-1,"price":3},"3":{"qty":1,"price":-4},"4":${OK}}`);
    expect(bd).not.toBeNull();
    expect(wealthPointValue(0, bd, untaxed)).toBe(-4 + 6);
    expect(wealthBreakdownRows(bd, untaxed).map(r => r.id)).toEqual(['3', '4']);
  });
});
