/**
 * The one valuation rule: value = signed Σ qty × taxed unit price, on both
 * legs, for loot AND spent. No clamps — a negative quantity reduces value.
 * `liveValue` is the overlay's entry to the same rule (live leg, numbers).
 *
 * `valueQty` / `valueItem` / `liveValue` are reached through a namespace cast
 * so this file typechecks before they exist.
 */
import {describe, expect, it} from 'vitest';
import * as V from '@/domain/valuation';
import {AUCTION_TAX_RATE, NO_TAX, makePriceLookup, type PriceLookup, type TaxConfig, type Valuation} from '@/domain/valuation';
import {makeItems} from '@/domain/session-analytics/__tests__/fixtures';

const valueQty = (V as Record<string, unknown>).valueQty as unknown as (q: Record<string | number, number>, p: PriceLookup) => Valuation;
const valueItem = (V as Record<string, unknown>).valueItem as unknown as (p: PriceLookup, id: string, qty: number) => Valuation;
const liveValue = (V as Record<string, unknown>).liveValue as unknown as (
  s: {drops: Record<number, number>; spent?: Record<number, number>},
  items: Record<string, import('@/shared/contracts/db').DbItem>,
  tax: TaxConfig,
) => {loot: number; cost: number; net: number};

const TAX_ON: TaxConfig = {enabled: true, rate: AUCTION_TAX_RATE};

/** '1' taxable card at 100, '2' exempt fuel at 10. */
const ITEMS = makeItems({'1': 100, '2': 10}, {'1': 'card', '2': 'fuel'});
/** Snapshot prices differ from live for the card only. */
const SNAP = {'1': 200};

describe('valueQty', () => {
  it('sums qty x price on both legs', () => {
    const prices = makePriceLookup(ITEMS, SNAP, NO_TAX);
    expect(valueQty({'1': 2, '2': 3}, prices)).toEqual({snapshot: 2 * 200 + 3 * 10, live: 2 * 100 + 3 * 10});
  });

  it('lets a negative quantity reduce value (no clamp), on both legs', () => {
    const prices = makePriceLookup(ITEMS, SNAP, NO_TAX);
    expect(valueQty({'1': 2, '2': -3}, prices)).toEqual({snapshot: 370, live: 170});
  });

  it('goes negative when negatives dominate', () => {
    const prices = makePriceLookup(ITEMS, SNAP, NO_TAX);
    expect(valueQty({'1': 1, '2': -30}, prices)).toEqual({snapshot: 200 - 300, live: 100 - 300});
  });

  it('is zero for an empty dict and for zero quantities', () => {
    const prices = makePriceLookup(ITEMS, SNAP, NO_TAX);
    expect(valueQty({}, prices)).toEqual({snapshot: 0, live: 0});
    expect(valueQty({'1': 0}, prices)).toEqual({snapshot: 0, live: 0});
  });

  it('taxes both legs, and fuel is untaxed', () => {
    const prices = makePriceLookup(ITEMS, SNAP, TAX_ON);
    // card: 2 x 200 x 0.85 = 340 (snapshot), 2 x 100 x 0.85 = 170 (live); fuel 3 x 10 untaxed
    expect(valueQty({'1': 2, '2': 3}, prices)).toEqual({snapshot: 340 + 30, live: 170 + 30});
  });

  it('shrinks a taxed negative toward zero rather than growing it', () => {
    const prices = makePriceLookup(ITEMS, SNAP, TAX_ON);
    expect(valueQty({'1': -2}, prices)).toEqual({snapshot: -340, live: -170});
  });

  it('accepts numeric keys (TrackerSnapshot drops)', () => {
    const prices = makePriceLookup(ITEMS, null, NO_TAX);
    expect(valueQty({1: 2, 2: -1} as Record<number, number>, prices)).toEqual({snapshot: 190, live: 190});
  });

  it('aliases the snapshot leg to live without a snapshot', () => {
    const prices = makePriceLookup(ITEMS, null, NO_TAX);
    expect(valueQty({'1': 3}, prices)).toEqual({snapshot: 300, live: 300});
  });

  it('values an item missing from the table at zero', () => {
    const prices = makePriceLookup(ITEMS, SNAP, NO_TAX);
    expect(valueQty({'99': 5}, prices)).toEqual({snapshot: 0, live: 0});
  });
});

describe('valueItem', () => {
  it('is the signed single-item case of valueQty', () => {
    const prices = makePriceLookup(ITEMS, SNAP, TAX_ON);
    expect(valueItem(prices, '1', 2)).toEqual({snapshot: 340, live: 170});
    expect(valueItem(prices, '1', -2)).toEqual({snapshot: -340, live: -170});
    expect(valueItem(prices, '2', 3)).toEqual({snapshot: 30, live: 30});
    expect(valueItem(prices, '1', 1)).toEqual(valueQty({'1': 1}, prices));
  });
});

describe('makePriceLookup coveredIds', () => {
  it('a snapshot covering only a spent id counts when the caller passes drops + spent ids', () => {
    const prices = makePriceLookup(ITEMS, {'2': 10}, NO_TAX, ['1', '2']);
    expect(prices.hasSnapshot).toBe(true);
  });
});

describe('makePriceLookup reads own keys only', () => {
  it('Object.prototype ids never produce NaN on the snapshot leg of a real snapshot', () => {
    const items = makeItems({'1': 100});
    const q: Record<string, number> = JSON.parse('{"constructor": 7, "toString": 9, "1": 1}');
    const prices = makePriceLookup(items, {'1': 100}, NO_TAX, Object.keys(q));
    const v = valueQty(q, prices);
    expect(v).toEqual({snapshot: 100, live: 100});
    expect(prices.isMissing('constructor')).toBe(true);
  });

  it('a snapshot is not counted as covering an id it only inherits', () => {
    const prices = makePriceLookup(makeItems({'1': 100}), {'1': 100}, NO_TAX, ['constructor', 'toString']);
    expect(prices.hasSnapshot).toBe(false);
    expect(prices.snapshot('constructor')).toBe(0);
    expect(prices.live('constructor')).toBe(0);
  });
});

describe('liveValue', () => {
  it('is loot, cost and net = loot - cost on the live leg', () => {
    expect(liveValue({drops: {1: 5}, spent: {2: 4}}, ITEMS, NO_TAX)).toEqual({loot: 500, cost: 40, net: 460});
  });

  it('treats an absent spent as zero cost', () => {
    expect(liveValue({drops: {1: 5}}, ITEMS, NO_TAX)).toEqual({loot: 500, cost: 0, net: 500});
  });

  it('is signed: a negative drop reduces loot, and net can go negative', () => {
    expect(liveValue({drops: {1: 1, 2: -3}}, ITEMS, NO_TAX)).toEqual({loot: 70, cost: 0, net: 70});
    expect(liveValue({drops: {2: 1}, spent: {1: 1}}, ITEMS, NO_TAX)).toEqual({loot: 10, cost: 100, net: -90});
  });

  it('applies the tax to both legs of the rule, fuel exempt', () => {
    expect(liveValue({drops: {1: 2, 2: 3}, spent: {1: 1}}, ITEMS, TAX_ON)).toEqual({loot: 170 + 30, cost: 85, net: 200 - 85});
  });

  it('equals the live leg of valueQty over the same lookup (one code path)', () => {
    const drops = {1: 7, 2: -2};
    const spent = {1: 3, 2: 1};
    const prices = makePriceLookup(ITEMS, null, TAX_ON);
    const loot = valueQty(drops, prices).live;
    const cost = valueQty(spent, prices).live;
    expect(liveValue({drops, spent}, ITEMS, TAX_ON)).toEqual({loot, cost, net: loot - cost});
  });

  it('is zero for empty input', () => {
    expect(liveValue({drops: {}}, ITEMS, NO_TAX)).toEqual({loot: 0, cost: 0, net: 0});
  });
});

// ---------------------------------------------------------------------------
// Adversarial: ids, prices, tax, keys
// ---------------------------------------------------------------------------
describe('valueQty adversarial', () => {
  /** '1' card @100, '2' fuel @10, '3' price 0, '4' fuel stored under its raw import name. */
  const ITEMS2 = makeItems({'1': 100, '2': 10, '3': 0, '4': 10}, {'1': 'card', '2': 'fuel', '4': 'Corrosion Material'});

  it('an unknown id is worth 0 on both legs, with or without a snapshot and tax', () => {
    for (const tax of [NO_TAX, TAX_ON]) {
      const prices = makePriceLookup(ITEMS2, {'1': 100}, tax);
      expect(valueQty({'777': 1000, '1': 1}, prices)).toEqual(valueQty({'1': 1}, prices));
    }
  });

  it('a price of 0 contributes nothing, even at a huge or negative quantity', () => {
    const prices = makePriceLookup(ITEMS2, null, TAX_ON);
    expect(valueQty({'3': 1e9}, prices)).toEqual({snapshot: 0, live: 0});
    expect(valueQty({'3': -1e9}, prices)).toEqual({snapshot: 0, live: 0});
  });

  it('a snapshot price of 0 is a real price: the snapshot leg is 0, the live leg is not', () => {
    const prices = makePriceLookup(ITEMS2, {'1': 0}, NO_TAX, ['1']);
    expect(prices.hasSnapshot).toBe(true);
    expect(valueQty({'1': 3}, prices)).toEqual({snapshot: 0, live: 300});
    expect(prices.isMissing('1')).toBe(false);
  });

  it('a snapshot price for an item absent from the item table is valued as taxable', () => {
    const prices = makePriceLookup(ITEMS2, {'55': 40}, TAX_ON, ['55']);
    expect(valueQty({'55': 2}, prices)).toEqual({snapshot: 2 * 40 * 0.85, live: 0});
  });

  it('taxed types lose the rate, fuel (also under its raw import name) does not, tax off leaves both gross', () => {
    const on  = makePriceLookup(ITEMS2, null, TAX_ON);
    const off = makePriceLookup(ITEMS2, null, NO_TAX);
    expect(valueQty({'1': 2}, on).live).toBeCloseTo(170, 9);
    expect(valueQty({'2': 2}, on).live).toBe(20);
    expect(valueQty({'4': 2}, on).live).toBe(20);
    expect(valueQty({'1': 2, '2': 2, '4': 2}, off).live).toBe(240);
  });

  it('a tax config with enabled:false ignores the rate; rate 0 enabled changes nothing', () => {
    const off = makePriceLookup(ITEMS2, null, {enabled: false, rate: 0.5});
    const zero = makePriceLookup(ITEMS2, null, {enabled: true, rate: 0});
    expect(valueQty({'1': 1}, off).live).toBe(100);
    expect(valueQty({'1': 1}, zero).live).toBe(100);
  });

  it('numeric and string keys are the same item and add up when both spellings appear', () => {
    const prices = makePriceLookup(ITEMS2, null, NO_TAX);
    // A JS object cannot hold both spellings of one key, so a merge of two
    // dicts (what a caller might do) is what is being modelled.
    const a = valueQty({1: 2} as Record<number, number>, prices);
    const b = valueQty({'1': 2}, prices);
    expect(a).toEqual(b);
    expect(valueQty({...{1: 2}, ...{'1': 5}} as Record<string, number>, prices).live).toBe(500);
  });

  it('prototype-ish ids ("__proto__", "constructor", "toString") are plain unknown ids on the live leg', () => {
    const q: Record<string, number> = JSON.parse('{"__proto__": 5, "constructor": 7, "toString": 9, "1": 1}');
    const prices = makePriceLookup(ITEMS2, null, TAX_ON);
    expect(Object.keys(q)).toContain('__proto__');
    expect(valueQty(q, prices)).toEqual({snapshot: 85, live: 85});
  });


  it('an empty dict, an empty snapshot and an empty item table are all zero and finite', () => {
    expect(valueQty({}, makePriceLookup({}, {}, TAX_ON))).toEqual({snapshot: 0, live: 0});
    expect(valueQty({'1': 5}, makePriceLookup({}, {}, TAX_ON))).toEqual({snapshot: 0, live: 0});
  });

  it('is linear: valueQty(a) + valueQty(b) = valueQty(a + b) on both legs, taxed', () => {
    const prices = makePriceLookup(ITEMS2, {'1': 120, '2': 7}, TAX_ON);
    const a = {'1': 3, '2': -2};
    const b = {'1': -5, '2': 4, '4': 1};
    const sum = {'1': -2, '2': 2, '4': 1};
    const va = valueQty(a, prices), vb = valueQty(b, prices), vs = valueQty(sum, prices);
    expect(va.snapshot + vb.snapshot).toBeCloseTo(vs.snapshot, 9);
    expect(va.live + vb.live).toBeCloseTo(vs.live, 9);
  });

  it('valueItem of an unknown id is 0, of qty 0 is 0 (not -0 surprises: equals 0)', () => {
    const prices = makePriceLookup(ITEMS2, null, TAX_ON);
    expect(valueItem(prices, 'nope', 5)).toEqual({snapshot: 0, live: 0});
    expect(valueItem(prices, '1', 0).live).toBe(0);
  });
});

describe('liveValue adversarial', () => {
  const ITEMS2 = makeItems({'1': 100, '2': 10, '3': 0}, {'1': 'card', '2': 'fuel'});

  it('uses the live leg only: a wildly different snapshot cannot change it', () => {
    const live = liveValue({drops: {1: 2}, spent: {1: 1}}, ITEMS2, TAX_ON);
    const snapped = makePriceLookup(ITEMS2, {'1': 99999}, TAX_ON, ['1']);
    expect(valueQty({'1': 2}, snapped).snapshot).not.toBe(live.loot);
    expect(valueQty({'1': 2}, snapped).live).toBeCloseTo(live.loot, 9);
    expect(live).toEqual({loot: 170, cost: 85, net: 85});
  });

  it('unknown ids, price 0 and an empty spent are all 0 without NaN', () => {
    const v = liveValue({drops: {999: 5, 3: 5}, spent: {}}, ITEMS2, TAX_ON);
    expect(v).toEqual({loot: 0, cost: 0, net: 0});
  });

  it('fuel is untaxed and a card is taxed on both loot and cost; net is loot - cost', () => {
    expect(liveValue({drops: {2: 10}, spent: {2: 4}}, ITEMS2, TAX_ON)).toEqual({loot: 100, cost: 40, net: 60});
    expect(liveValue({drops: {1: 10}, spent: {1: 4}}, ITEMS2, TAX_ON).net).toBeCloseTo(510, 9);
    expect(liveValue({drops: {1: 10}, spent: {1: 4}}, ITEMS2, NO_TAX).net).toBe(600);
  });

  it('numeric keys, string keys and a mix behave identically', () => {
    const num = liveValue({drops: {1: 1}, spent: {2: 1}}, ITEMS2, NO_TAX);
    const str = liveValue({drops: {'1': 1}, spent: {'2': 1}} as never, ITEMS2, NO_TAX);
    expect(str).toEqual(num);
  });

  it('a spent item that is also looted nets out (signed on both sides)', () => {
    expect(liveValue({drops: {1: 3}, spent: {1: 3}}, ITEMS2, TAX_ON).net).toBeCloseTo(0, 9);
  });

  it('never mutates its inputs', () => {
    const drops = {1: 1}; const spent = {2: 1};
    liveValue({drops, spent}, ITEMS2, TAX_ON);
    expect(drops).toEqual({1: 1});
    expect(spent).toEqual({2: 1});
  });
});
