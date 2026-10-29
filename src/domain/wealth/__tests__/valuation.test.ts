import {describe, it, expect} from 'vitest';
import type {DbItem} from '@/shared/contracts/db';
import type {FilterRule} from '@/shared/item-filter';
import {AUCTION_TAX_RATE, NO_TAX, taxedValue, type TaxConfig} from '@/domain/valuation';
import {
  compactPointValue, compactWealthPoint, parseWealthBreakdown, rawTypeLookup, wealthBreakdownRows,
  wealthPointValue, wealthValuer, type WealthBreakdown, type WealthValuation,
} from '..';

const TAX_ON: TaxConfig = {enabled: true, rate: AUCTION_TAX_RATE};

function item(id: string, type: string): DbItem {
  return {id, name: `item ${id}`, type, price: 0, priceDate: 0};
}

const ITEMS: DbItem[] = [
  item('100', 'ember'),
  item('200', 'fuel'),
  item('201', 'Corrosion Material'), // fuel under its raw import name
  item('300', 'equipment'),
  item('400', 'card'),
  item('constructor', 'cube'),
];
const rawTypeOf = rawTypeLookup(ITEMS);

/** A stored row the way the recorder writes one: qty > 0 items, total = qty x
 *  price, value = Σ totals, then a JSON round trip (which reorders integer keys). */
function recorded(entries: [id: string, qty: number, price: number][]): {value: number; json: string} {
  const breakdown: WealthBreakdown = {};
  for (const [id, qty, price] of entries) breakdown[id] = {qty, price, total: qty * price};
  const json  = JSON.stringify(breakdown);
  const value = Object.values(JSON.parse(json) as WealthBreakdown).reduce((s, e) => s + e.total, 0);
  return {value, json};
}

function valuation(tax: TaxConfig, rules: FilterRule[] = []): WealthValuation {
  return {tax, rawTypeOf, rules};
}

const hide = (kind: FilterRule['kind'], scopes: FilterRule['scopes'] = ['wealth']): FilterRule =>
  ({id: crypto.randomUUID(), action: 'hide', kind, scopes});

const SAMPLE = recorded([
  ['100', 3, 12.5],
  ['200', 40, 0.37],
  ['201', 7, 1.1],
  ['300', 1, 980.25],
  ['400', 12, 3.333],
  ['999', 2, 50],        // unknown item: taxable, type 'other'
  ['constructor', 5, 4], // prototype-named id
]);

describe('parseWealthBreakdown', () => {
  it('parses a stored object', () => {
    expect(parseWealthBreakdown('{"1":{"qty":2,"price":3,"total":6}}')).toEqual({'1': {qty: 2, price: 3, total: 6}});
    expect(parseWealthBreakdown('{}')).toEqual({});
  });

  it('is null for anything that is not a JSON object', () => {
    for (const bad of ['', 'not json', '{"1":', 'null', '5', '"str"', '[1,2]']) {
      expect(parseWealthBreakdown(bad), bad).toBeNull();
    }
  });
});

describe('wealthPointValue', () => {
  it('with no filter and tax off equals the stored gross value', () => {
    expect(wealthPointValue(SAMPLE.value, parseWealthBreakdown(SAMPLE.json), valuation(NO_TAX))).toBe(SAMPLE.value);
  });

  it('with tax on takes the cut from every taxable item and none from fuel', () => {
    const b = parseWealthBreakdown(recorded([['100', 10, 100], ['200', 10, 100], ['201', 10, 100]]).json);
    // ember taxed: 850; fuel and raw-named fuel exempt: 1000 + 1000.
    expect(wealthPointValue(3000, b, valuation(TAX_ON))).toBe(2850);
  });

  it('omits items the wealth-scoped rules hide', () => {
    const b = parseWealthBreakdown(recorded([['100', 10, 100], ['300', 1, 500], ['400', 2, 25]]).json);
    expect(wealthPointValue(1550, b, valuation(NO_TAX, [hide({type: 'by-type', itemType: 'equipment'})]))).toBe(1050);
    expect(wealthPointValue(1550, b, valuation(NO_TAX, [hide({type: 'by-item', itemId: '400'})]))).toBe(1500);
    expect(wealthPointValue(1550, b, valuation(TAX_ON, [hide({type: 'by-type', itemType: 'equipment'})])))
      .toBe(850 + 42.5);
  });

  it('evaluates by-type against today\'s types, raw names mapped', () => {
    const b = parseWealthBreakdown(recorded([['200', 1, 10], ['201', 1, 10], ['999', 1, 10]]).json);
    expect(wealthPointValue(30, b, valuation(NO_TAX, [hide({type: 'by-type', itemType: 'fuel'})]))).toBe(10);
    // An item missing from the table is 'other'.
    expect(wealthPointValue(30, b, valuation(NO_TAX, [hide({type: 'by-type', itemType: 'other'})]))).toBe(20);
  });

  it('ignores rules not scoped to wealth', () => {
    const b = parseWealthBreakdown(SAMPLE.json);
    const rules = [hide({type: 'by-type', itemType: 'equipment'}, ['session', 'map'])];
    expect(wealthPointValue(SAMPLE.value, b, valuation(NO_TAX, rules))).toBe(SAMPLE.value);
  });

  it('is 0, not the stored value, when every item is hidden', () => {
    const b = parseWealthBreakdown(recorded([['300', 1, 500]]).json);
    expect(wealthPointValue(500, b, valuation(TAX_ON, [hide({type: 'by-type', itemType: 'equipment'})]))).toBe(0);
  });

  it('falls back to the stored value for an empty or unparseable breakdown, whatever the policy', () => {
    const policy = valuation(TAX_ON, [hide({type: 'by-type', itemType: 'other'})]);
    expect(wealthPointValue(1234.5, parseWealthBreakdown('{}'), policy)).toBe(1234.5);
    expect(wealthPointValue(1234.5, parseWealthBreakdown('garbage'), policy)).toBe(1234.5);
    expect(wealthPointValue(1234.5, null, policy)).toBe(1234.5);
  });

  it('values a prototype-named id by its own type', () => {
    const b = parseWealthBreakdown(recorded([['constructor', 10, 10]]).json);
    expect(wealthPointValue(100, b, valuation(NO_TAX, [hide({type: 'by-type', itemType: 'cube'})]))).toBe(0);
    expect(wealthPointValue(100, b, valuation(TAX_ON))).toBe(85);
  });
});

describe('compact form', () => {
  it('keeps ids and per-item gross, parallel', () => {
    const c = compactWealthPoint(36, parseWealthBreakdown('{"7":{"qty":3,"price":2,"total":6},"8":{"qty":5,"price":6,"total":30}}'));
    expect(c.ids).toEqual(['7', '8']);
    expect([...c.gross]).toEqual([6, 30]);
    expect(c.storedValue).toBe(36);
    expect(c.detailed).toBe(true);
  });

  it('drops qty <= 0 entries, the same rule as the rows, and ignores the stored totals', () => {
    const b: WealthBreakdown = {
      '100': {qty: 0,  price: 10, total: 999},
      '300': {qty: -3, price: 10, total: -30},
      '400': {qty: 2,  price: 10, total: 999},
      '200': {qty: 5,  price: 2,  total: 999},
    };
    const c = compactWealthPoint(-1, b);
    expect(c.ids).toEqual(['200', '400']); // integer keys enumerate ascending
    expect([...c.gross]).toEqual([10, 20]);
    expect(c.detailed).toBe(true);
    for (const v of [valuation(NO_TAX), valuation(TAX_ON), valuation(TAX_ON, [hide({type: 'by-type', itemType: 'card'})])]) {
      const rows = wealthBreakdownRows(b, v);
      expect(compactPointValue(c, v)).toBe(rows.reduce((s, r) => s + r.total, 0));
      expect(wealthPointValue(-1, b, v)).toBe(compactPointValue(c, v));
    }
    expect(compactPointValue(c, valuation(NO_TAX))).toBe(30);
    expect(compactPointValue(c, valuation(TAX_ON))).toBeCloseTo(17 + 10, 9); // card taxed, fuel exempt
  });

  it('a breakdown whose every entry has qty <= 0 is worth 0 (it has detail), not its stored value', () => {
    const b: WealthBreakdown = {'100': {qty: 0, price: 10, total: 0}, '300': {qty: -1, price: 5, total: -5}};
    const c = compactWealthPoint(-5, b);
    expect(c.ids).toEqual([]);
    expect(c.detailed).toBe(true);
    expect(compactPointValue(c, valuation(TAX_ON))).toBe(0);
    expect(wealthBreakdownRows(b, valuation(TAX_ON))).toEqual([]);
  });

  it('one valuer over many points equals valuing each point alone', () => {
    const points = [
      compactWealthPoint(SAMPLE.value, parseWealthBreakdown(SAMPLE.json)),
      compactWealthPoint(30, parseWealthBreakdown(recorded([['200', 1, 10], ['201', 1, 10], ['999', 1, 10]]).json)),
      compactWealthPoint(77, null),
    ];
    const v = valuation(TAX_ON, [hide({type: 'by-type', itemType: 'fuel'}), hide({type: 'by-item', itemId: '400'})]);
    const value = wealthValuer(v);
    expect(points.map(value)).toEqual(points.map(p => compactPointValue(p, v)));
    expect(points.map(value)).toEqual(points.map(value)); // memo stable across reuse
  });

  it('values identically to the parsed breakdown under every policy', () => {
    const b = parseWealthBreakdown(SAMPLE.json);
    const c = compactWealthPoint(SAMPLE.value, b);
    const policies = [
      valuation(NO_TAX),
      valuation(TAX_ON),
      valuation(TAX_ON, [hide({type: 'by-type', itemType: 'fuel'})]),
      valuation(NO_TAX, [hide({type: 'by-item', itemId: '300'}), hide({type: 'by-type', itemType: 'other'})]),
    ];
    for (const v of policies) expect(compactPointValue(c, v)).toBe(wealthPointValue(SAMPLE.value, b, v));
  });

  it('an empty breakdown compacts to no items and shows its stored value', () => {
    for (const b of [null, parseWealthBreakdown('{}')]) {
      const c = compactWealthPoint(77, b);
      expect(c.ids).toEqual([]);
      expect(c.gross.length).toBe(0);
      expect(c.detailed).toBe(false);
      expect(compactPointValue(c, valuation(TAX_ON, [hide({type: 'by-type', itemType: 'other'})]))).toBe(77);
    }
  });
});

describe('wealthBreakdownRows', () => {
  it('values each row with the taxed unit price and taxed total', () => {
    const b = parseWealthBreakdown(recorded([['100', 10, 100], ['200', 4, 25]]).json);
    expect(wealthBreakdownRows(b, valuation(TAX_ON))).toEqual([
      {id: '100', qty: 10, unitPrice: 85, total: 850},
      {id: '200', qty: 4,  unitPrice: 25, total: 100},
    ]);
    expect(wealthBreakdownRows(b, valuation(NO_TAX))).toEqual([
      {id: '100', qty: 10, unitPrice: 100, total: 1000},
      {id: '200', qty: 4,  unitPrice: 25,  total: 100},
    ]);
  });

  it('drops qty <= 0 entries and ignores the stored total', () => {
    const b: WealthBreakdown = {
      '1': {qty: 0,  price: 10, total: 999},
      '2': {qty: -3, price: 10, total: -30},
      '3': {qty: 2,  price: 10, total: 999},
    };
    expect(wealthBreakdownRows(b, valuation(NO_TAX))).toEqual([{id: '3', qty: 2, unitPrice: 10, total: 20}]);
  });

  it('omits hidden items', () => {
    const b = parseWealthBreakdown(SAMPLE.json);
    const rows = wealthBreakdownRows(b, valuation(NO_TAX, [hide({type: 'by-type', itemType: 'equipment'})]));
    expect(rows.map(r => r.id)).not.toContain('300');
    expect(rows).toHaveLength(Object.keys(b!).length - 1);
  });

  it('is empty for an empty or unparseable breakdown', () => {
    expect(wealthBreakdownRows(parseWealthBreakdown('{}'), valuation(TAX_ON))).toEqual([]);
    expect(wealthBreakdownRows(null, valuation(TAX_ON))).toEqual([]);
  });

  it('rows sum to the point value of a recorded breakdown', () => {
    const b = parseWealthBreakdown(SAMPLE.json);
    for (const v of [valuation(NO_TAX), valuation(TAX_ON), valuation(TAX_ON, [hide({type: 'by-type', itemType: 'card'})])]) {
      const sum = wealthBreakdownRows(b, v).reduce((s, r) => s + r.total, 0);
      expect(sum).toBe(wealthPointValue(SAMPLE.value, b, v));
    }
  });
});

// The renderer's own valuation before 4.5c moved the display to main, kept
// literally as an oracle: tax off → the stored value; on → Σ taxedValue per
// parsed entry, type from a plain items record; an empty or unparseable
// breakdown → the stored value. With no filter the domain rule must give the
// same numbers, so the move changes no figure a user had seen.
function legacyRendererValue(
  value: number, json: string, items: Record<string, DbItem>, tax: TaxConfig,
): number {
  if (!tax.enabled) return value;
  let parsed: WealthBreakdown | null;
  try { parsed = JSON.parse(json) as WealthBreakdown; } catch { parsed = null; }
  if (!parsed || Object.keys(parsed).length === 0) return value;
  let total = 0;
  for (const [itemId, entry] of Object.entries(parsed)) {
    total += taxedValue(entry.qty, entry.price, items[itemId]?.type, tax);
  }
  return total;
}

describe('equivalence with the pre-4.5c renderer rule (no filter)', () => {
  const itemsRecord = Object.fromEntries(ITEMS.filter(i => i.id !== 'constructor').map(i => [i.id, i]));
  const rows = [
    SAMPLE,
    recorded([['100', 1, 0.1], ['201', 2, 0.2], ['400', 3, 0.3]]),
    recorded([['200', 1000, 0.0123], ['300', 2, 1e6], ['999', 17, 7.77]]),
    {value: 4321, json: '{}'},
    {value: 99, json: 'not json'},
  ];
  const lookup = rawTypeLookup(Object.values(itemsRecord));

  for (const tax of [NO_TAX, TAX_ON]) {
    it(`gives the same value with tax ${tax.enabled ? 'on' : 'off'}`, () => {
      rows.forEach((r) => {
        const expected = legacyRendererValue(r.value, r.json, itemsRecord, tax);
        expect(wealthPointValue(r.value, parseWealthBreakdown(r.json), {tax, rawTypeOf: lookup, rules: []}), r.json)
          .toBe(expected);
      });
    });
  }
});
