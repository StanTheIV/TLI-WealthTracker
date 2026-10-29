import type {WealthBreakdownRow} from '@/shared/contracts/wealth';
import type {FilterRule} from '@/shared/item-filter';
import {mapRawType} from '@/shared/items';
import {includesItem} from '@/domain/item-filter';
import {NO_TAX, taxedGross, taxedUnitPrice, taxedValue, type TaxConfig} from '@/domain/valuation';

/** One item of a stored wealth reading. `price` is the price at record time;
 *  `total` is its gross qty x price and is never read back — it is type-blind,
 *  so neither the fuel tax exemption nor a by-type rule can be applied to it. */
export interface WealthBreakdownEntry {
  qty:   number;
  price: number;
  total: number;
}

/** A `wealth_datapoints.breakdown` column, parsed: item id → entry. */
export type WealthBreakdown = Record<string, WealthBreakdownEntry>;

/** Everything a displayed wealth figure depends on besides the stored row. */
export interface WealthValuation {
  tax:       TaxConfig;
  /** Today's raw `DbItem.type` by id; undefined for an item not in the table. */
  rawTypeOf: (itemId: string) => string | undefined;
  /** The active filter's rules (its 'wealth' scope applies); [] for none. */
  rules:     readonly FilterRule[];
}

export type {WealthBreakdownRow};

/** A point's breakdown reduced to what re-valuing it needs: the ids and
 *  per-item gross of its positive-qty items (the Item Breakdown's rows),
 *  parallel. Immutable — a stored row never changes. */
export interface CompactWealthPoint {
  /** The stored gross value: what a point without per-item detail displays. */
  readonly storedValue: number;
  /** False for an empty or unparseable breakdown: the point shows `storedValue`. */
  readonly detailed:    boolean;
  readonly ids:         readonly string[];
  readonly gross:       Float64Array;
}

/** Parses a stored breakdown column; null when it isn't a JSON object. */
export function parseWealthBreakdown(json: string): WealthBreakdown | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as WealthBreakdown;
  } catch {
    return null;
  }
}

/** A `rawTypeOf` over an item list. A Map, not an object: ids are arbitrary
 *  strings, and a plain lookup of 'constructor' would hit the prototype. */
export function rawTypeLookup(items: Iterable<{id: string; type: string}>): (itemId: string) => string | undefined {
  const types = new Map<string, string>();
  for (const item of items) types.set(item.id, item.type);
  return itemId => types.get(itemId);
}

/** Whether an item counts toward wealth under `v`'s rules and today's types. */
function wealthInclusion(v: WealthValuation): (itemId: string) => boolean {
  const typeOf = (itemId: string) => mapRawType(v.rawTypeOf(itemId));
  return itemId => includesItem(v.rules, typeOf, itemId, 'wealth');
}

/** Same rule as the rows: a qty ≤ 0 entry counts for nothing. */
export function compactWealthPoint(storedValue: number, breakdown: WealthBreakdown | null): CompactWealthPoint {
  const entries  = breakdown ? Object.entries(breakdown) : [];
  const positive = entries.filter(([, e]) => e.qty > 0);
  const ids      = positive.map(([id]) => id);
  const gross    = Float64Array.from(positive, ([, e]) => taxedValue(e.qty, e.price, undefined, NO_TAX));
  return {storedValue, detailed: entries.length > 0, ids, gross};
}

/**
 * A point's displayed value: Σ over included items of the taxed gross.
 *
 * A point with no per-item detail (rows recorded before the breakdown column,
 * or an unparseable one) can be neither filtered nor taxed, so it shows its
 * stored value — a history spanning that migration steps where detail begins.
 * A point whose items are all filtered out is worth 0, not its stored value.
 */
export function compactPointValue(point: CompactWealthPoint, v: WealthValuation): number {
  return wealthValuer(v)(point);
}

/** `compactPointValue` for many points under one policy: each item's
 *  inclusion and type are resolved once, not once per point. */
export function wealthValuer(v: WealthValuation): (point: CompactWealthPoint) => number {
  const included = wealthInclusion(v);
  // id → its raw type when included, null when hidden.
  const resolved = new Map<string, {rawType: string | undefined} | null>();
  const resolve = (id: string) => {
    let r = resolved.get(id);
    if (r === undefined) {
      r = included(id) ? {rawType: v.rawTypeOf(id)} : null;
      resolved.set(id, r);
    }
    return r;
  };
  return point => {
    if (!point.detailed) return point.storedValue;
    let total = 0;
    for (let i = 0; i < point.ids.length; i++) {
      const r = resolve(point.ids[i]);
      if (r) total += taxedGross(point.gross[i], r.rawType, v.tax);
    }
    return total;
  };
}

/** `compactPointValue` straight from a parsed breakdown. */
export function wealthPointValue(storedValue: number, breakdown: WealthBreakdown | null, v: WealthValuation): number {
  return compactPointValue(compactWealthPoint(storedValue, breakdown), v);
}

/** The Item Breakdown rows of a reading: included items with a positive qty,
 *  in breakdown order. Their totals sum to `wealthPointValue` of the same
 *  breakdown, unless it has no detail (no rows; the stored value). */
export function wealthBreakdownRows(breakdown: WealthBreakdown | null, v: WealthValuation): WealthBreakdownRow[] {
  if (!breakdown) return [];
  const included = wealthInclusion(v);
  const rows: WealthBreakdownRow[] = [];
  for (const [id, entry] of Object.entries(breakdown)) {
    if (!(entry.qty > 0) || !included(id)) continue;
    const rawType = v.rawTypeOf(id);
    rows.push({
      id,
      qty:       entry.qty,
      unitPrice: taxedUnitPrice(entry.price, rawType, v.tax),
      total:     taxedValue(entry.qty, entry.price, rawType, v.tax),
    });
  }
  return rows;
}
