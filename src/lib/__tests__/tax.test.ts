import {describe, it, expect} from 'vitest';
import {ITEM_TYPE_CONFIG, ITEM_TYPES} from '@/types/itemType';
import {AUCTION_TAX_RATE, NO_TAX, isTaxable, taxedUnitPrice, taxedValue, type TaxConfig} from '../tax';

const TAX_ON: TaxConfig = {enabled: true, rate: AUCTION_TAX_RATE};

describe('isTaxable', () => {
  it('exempts fuel and taxes every other item type', () => {
    for (const type of ITEM_TYPES) {
      expect(isTaxable(type), type).toBe(type !== 'fuel');
    }
  });

  // The items.type column can hold an unmapped import name, so comparing
  // against 'fuel' directly would tax fuel that arrived via the API/batch path.
  it('exempts fuel stored under its raw material name', () => {
    for (const raw of ITEM_TYPE_CONFIG.fuel.rawNames) {
      expect(isTaxable(raw), raw).toBe(false);
    }
  });

  it('taxes an unknown or missing type — it falls through to "other"', () => {
    expect(isTaxable(undefined)).toBe(true);
    expect(isTaxable('')).toBe(true);
    expect(isTaxable('Some Future Material')).toBe(true);
  });
});

describe('taxedValue', () => {
  it('is bit-identical to qty * price when disabled', () => {
    expect(taxedValue(7, 13.37, 'card', NO_TAX)).toBe(7 * 13.37);
    expect(taxedValue(3, 10, 'fuel', NO_TAX)).toBe(3 * 10);
  });

  it('takes 15% off a taxable item and nothing off fuel', () => {
    expect(taxedValue(10, 100, 'card', TAX_ON)).toBe(850);
    expect(taxedValue(10, 100, 'fuel', TAX_ON)).toBe(1000);
  });

  // A negative qty is an auction-house conversion: the sale really did net 15%
  // less, so the deduction shrinks rather than growing.
  it('scales a negative quantity toward zero', () => {
    expect(taxedValue(-10, 100, 'card', TAX_ON)).toBe(-850);
    expect(taxedValue(-10, 100, 'fuel', TAX_ON)).toBe(-1000);
  });

  it('handles a zero price and a zero quantity', () => {
    expect(taxedValue(5, 0, 'card', TAX_ON)).toBe(0);
    expect(taxedValue(0, 500, 'card', TAX_ON)).toBe(0);
  });
});

describe('taxedUnitPrice', () => {
  it('is the per-unit form of the same policy', () => {
    expect(taxedUnitPrice(100, 'card', TAX_ON)).toBe(85);
    expect(taxedUnitPrice(100, 'fuel', TAX_ON)).toBe(100);
    expect(taxedUnitPrice(100, 'card', NO_TAX)).toBe(100);
  });

  // Tables render a unit price beside a total; if these two drifted the row
  // would read as broken arithmetic. Pinned at specific values rather than
  // property-tested — the identity is not guaranteed by IEEE-754 in general.
  it('multiplies back up to taxedValue for representative rows', () => {
    const cases: Array<[number, number, string]> = [
      [10, 100, 'card'],
      [3,  250, 'ember'],
      [7,   50, 'compass'],
      [10, 100, 'fuel'],
    ];
    for (const [qty, price, type] of cases) {
      expect(taxedUnitPrice(price, type, TAX_ON) * qty, `${qty}x${price} ${type}`)
        .toBe(taxedValue(qty, price, type, TAX_ON));
    }
  });
});
