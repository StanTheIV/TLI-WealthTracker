/**
 * Step 4.5 adversarial: seeded property checks of the wealth valuation
 * (compact form vs the breakdown rows), the pure filter against the pre-4.5
 * engine, and hostile breakdown columns.
 */
import {describe, it, expect} from 'vitest';
import {
  compactPointValue, compactWealthPoint, parseWealthBreakdown, rawTypeLookup, wealthBreakdownRows,
  wealthPointValue, wealthValuer, type WealthBreakdown, type WealthValuation,
} from '../valuation';
import {includesItem} from '@/domain/item-filter';
import {AUCTION_TAX_RATE, NO_TAX} from '@/domain/valuation';
import {ItemFilterEngine} from '@/main/engine/item-filter';
import {FILTER_SCOPES, type FilterRule, type FilterScope} from '@/shared/item-filter';
import {ITEM_TYPES, type ItemType} from '@/shared/items';
import {int, pick, rng} from '@/test/prng';

const IDS       = ['1', '2', '3', '10', '100', '101', '5000', 'constructor', 'toString', 'a b', '007'];
const RAW_TYPES = ['Remembrance Material', 'Corrosion Material', 'Compass', 'Dream Material', 'Cube Material',
  'Memory Fluorescence', 'equipment', 'fuel', 'skill', '', 'Weird Thing', undefined];

function randomRules(r: () => number): FilterRule[] {
  const n = int(r, 0, 5);
  return Array.from({length: n}, (_, i): FilterRule => ({
    id:     `r${i}`,
    action: r() < 0.5 ? 'hide' : 'show',
    scopes: FILTER_SCOPES.filter(() => r() < 0.5),
    kind:   r() < 0.5
      ? {type: 'by-item', itemId: pick(r, IDS)}
      : {type: 'by-type', itemType: pick(r, ITEM_TYPES)},
  }));
}

function randomBreakdown(r: () => number): WealthBreakdown {
  const out: WealthBreakdown = {};
  for (const id of IDS) {
    if (r() < 0.4) continue;
    const qty = r() < 0.15 ? -int(r, 0, 20) : int(r, 0, 500);
    const price = Math.round(r() * 10_000) / 100;
    out[id] = {qty, price, total: qty * price};
  }
  return out;
}

function randomValuation(r: () => number): WealthValuation {
  const types = new Map<string, string | undefined>(IDS.filter(() => r() < 0.8).map(id => [id, pick(r, RAW_TYPES)]));
  return {
    tax:       r() < 0.5 ? {enabled: true, rate: AUCTION_TAX_RATE} : NO_TAX,
    rawTypeOf: id => types.get(id),
    rules:     randomRules(r),
  };
}

describe('compactPointValue vs breakdown rows (property)', () => {
  it('Σ rows.total equals the compact value for every detailed point, any rules x tax x types', () => {
    const r = rng(45);
    for (let i = 0; i < 1500; i++) {
      const bd = randomBreakdown(r);
      const v  = randomValuation(r);
      const stored = Object.values(bd).reduce((s, e) => s + e.qty * e.price, 0);
      const compact = compactWealthPoint(stored, bd);
      const rows  = wealthBreakdownRows(bd, v);
      const total = rows.reduce((s, x) => s + x.total, 0);
      if (Object.keys(bd).length === 0) {
        expect(compactPointValue(compact, v)).toBe(stored);
        expect(rows).toEqual([]);
        continue;
      }
      expect(compactPointValue(compact, v)).toBeCloseTo(total, 6);
      // the one-shot helper and the batch valuer agree with the compact form
      expect(wealthPointValue(stored, bd, v)).toBe(compactPointValue(compact, v));
      expect(wealthValuer(v)(compact)).toBe(compactPointValue(compact, v));
      // rows are positive-qty only and unique
      expect(rows.every(x => x.qty > 0)).toBe(true);
      expect(new Set(rows.map(x => x.id)).size).toBe(rows.length);
    }
  });

  it('with no rules and no tax the value is Σ positive-qty gross', () => {
    const r = rng(46);
    for (let i = 0; i < 300; i++) {
      const bd = randomBreakdown(r);
      if (Object.keys(bd).length === 0) continue;
      const v: WealthValuation = {tax: NO_TAX, rawTypeOf: () => undefined, rules: []};
      const expected = Object.values(bd).filter(e => e.qty > 0).reduce((s, e) => s + e.qty * e.price, 0);
      expect(wealthPointValue(0, bd, v)).toBeCloseTo(expected, 6);
    }
  });

  it('a reused valuer gives the same numbers as a fresh one per point (memoised inclusion is not stale)', () => {
    const r = rng(47);
    const v = randomValuation(r);
    const shared = wealthValuer(v);
    for (let i = 0; i < 300; i++) {
      const c = compactWealthPoint(1, randomBreakdown(r));
      expect(shared(c)).toBe(wealthValuer(v)(c));
    }
  });
});

describe('includesItem vs the pre-4.5 ItemFilterEngine logic (property)', () => {
  // The engine's rule walk exactly as it was before 4.5a.
  function legacy(rules: FilterRule[], types: Map<string, ItemType>, itemId: number, scope: FilterScope): boolean {
    const idStr = String(itemId);
    for (const rule of rules) {
      if (!rule.scopes.includes(scope)) continue;
      const m = rule.kind.type === 'by-item'
        ? rule.kind.itemId === idStr
        : rule.kind.type === 'by-type' ? (types.get(idStr) ?? 'other') === rule.kind.itemType : false;
      if (m) return rule.action === 'show';
    }
    return true;
  }

  it('ItemFilterEngine.shouldInclude is the legacy walk for random rules, types, ids and scopes', () => {
    const r = rng(48);
    const NUM_IDS = [1, 2, 3, 10, 100, 101, 5000, 7];
    for (let i = 0; i < 400; i++) {
      const rules = randomRules(r).map(rule => rule.kind.type === 'by-item'
        ? {...rule, kind: {type: 'by-item' as const, itemId: String(pick(r, NUM_IDS))}} : rule);
      const types = new Map<string, ItemType>(NUM_IDS.filter(() => r() < 0.7).map(n => [String(n), pick(r, ITEM_TYPES)]));
      const eng = new ItemFilterEngine(rules, types);
      for (const id of NUM_IDS) for (const scope of FILTER_SCOPES) {
        expect(eng.shouldInclude(id, scope)).toBe(legacy(rules, types, id, scope));
        expect(includesItem(rules, x => types.get(x), String(id), scope)).toBe(legacy(rules, types, id, scope));
      }
    }
  });

  it('the engine sees item-type map mutations made after construction (shared map)', () => {
    const types = new Map<string, ItemType>();
    const rules: FilterRule[] = [{id: 'r', action: 'hide', scopes: ['wealth'], kind: {type: 'by-type', itemType: 'cube'}}];
    const eng = new ItemFilterEngine(rules, types);
    expect(eng.shouldInclude(9, 'wealth')).toBe(true);
    types.set('9', 'cube');
    expect(eng.shouldInclude(9, 'wealth')).toBe(false);
  });

  it('an unknown rule kind (stored JSON from a newer build) matches nothing and falls through', () => {
    const rules = [
      {id: 'x', action: 'hide', scopes: ['wealth'], kind: {type: 'by-rarity', rarity: 'rare'}},
      {id: 'y', action: 'hide', scopes: ['wealth'], kind: {type: 'by-item', itemId: '5'}},
    ] as unknown as FilterRule[];
    expect(includesItem(rules, () => undefined, '4', 'wealth')).toBe(true);
    expect(includesItem(rules, () => undefined, '5', 'wealth')).toBe(false);
  });
});

describe('hostile breakdown JSON', () => {
  it.each([
    ['empty string', ''], ['array', '[]'], ['array of entries', '[{"qty":1,"price":1,"total":1}]'], ['null', 'null'],
    ['number', '5'], ['string', '"x"'], ['boolean', 'true'], ['truncated', '{"1":{"qty":1'], ['garbage', 'not json'],
  ])('%s parses to null and the point shows its stored value', (_n, json) => {
    const bd = parseWealthBreakdown(json);
    expect(bd).toBeNull();
    const v: WealthValuation = {tax: {enabled: true, rate: 0.15}, rawTypeOf: () => undefined, rules: []};
    expect(wealthPointValue(77, bd, v)).toBe(77);
    expect(wealthBreakdownRows(bd, v)).toEqual([]);
  });

  it('an empty object is "no detail": stored value, no rows', () => {
    const v: WealthValuation = {tax: NO_TAX, rawTypeOf: () => undefined, rules: []};
    expect(wealthPointValue(12, parseWealthBreakdown('{}'), v)).toBe(12);
  });

  it("an own '__proto__' key is an ordinary item id, valued once and not polluting anything", () => {
    const bd = parseWealthBreakdown('{"__proto__":{"qty":2,"price":3,"total":6},"1":{"qty":1,"price":1,"total":1}}')!;
    const v: WealthValuation = {tax: NO_TAX, rawTypeOf: rawTypeLookup([{id: '__proto__', type: 'Compass'}]), rules: []};
    expect(wealthPointValue(0, bd, v)).toBe(7);
    expect(wealthBreakdownRows(bd, v).map(x => x.id).sort()).toEqual(['1', '__proto__']);
    expect(({} as Record<string, unknown>).qty).toBeUndefined();
  });

  it("ids like 'constructor' look up the item table by Map, not the prototype", () => {
    const lookup = rawTypeLookup([{id: '1', type: 'Compass'}]);
    expect(lookup('constructor')).toBeUndefined();
    expect(lookup('__proto__')).toBeUndefined();
    expect(lookup('1')).toBe('Compass');
  });

  it('qty NaN / zero / negative entries are dropped, positive kept', () => {
    const bd = {
      a: {qty: NaN, price: 5, total: NaN}, b: {qty: 0, price: 5, total: 0}, c: {qty: -3, price: 5, total: -15},
      d: {qty: 2, price: 5, total: 10},
    } as WealthBreakdown;
    const v: WealthValuation = {tax: NO_TAX, rawTypeOf: () => undefined, rules: []};
    expect(wealthBreakdownRows(bd, v).map(x => x.id)).toEqual(['d']);
    expect(wealthPointValue(0, bd, v)).toBe(10);
  });

  it('a detailed point whose items are all non-positive is worth 0, not its stored value', () => {
    const bd: WealthBreakdown = {a: {qty: -1, price: 5, total: -5}};
    const v: WealthValuation = {tax: NO_TAX, rawTypeOf: () => undefined, rules: []};
    expect(wealthPointValue(999, bd, v)).toBe(0);
  });

  it('a NaN price does not throw (it poisons only its own point)', () => {
    const bd = {a: {qty: 1, price: NaN, total: NaN}, b: {qty: 1, price: 1, total: 1}} as WealthBreakdown;
    const v: WealthValuation = {tax: NO_TAX, rawTypeOf: () => undefined, rules: []};
    expect(() => wealthPointValue(0, bd, v)).not.toThrow();
  });
});
