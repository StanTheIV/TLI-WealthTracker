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
