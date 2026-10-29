import type {WealthBreakdownRow} from '@/shared/contracts/wealth';
import type {FilterRule} from '@/shared/item-filter';
import {mapRawType} from '@/shared/items';
import {includesItem} from '@/domain/item-filter';
import {NO_TAX, taxedGross, taxedUnitPrice, taxedValue, type TaxConfig} from '@/domain/valuation';

/** One item of a stored wealth reading. `price` is the price at record time;
 *  `total` is its gross qty x price and is neither validated nor read back — it
 *  is type-blind, so neither the fuel tax exemption nor a by-type rule can be
 *  applied to it. */
export interface WealthBreakdownEntry {
  qty:    number;
  price:  number;
  total?: unknown;
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

/** Item ids interned to small indices, so the points one owner caches share a
 *  single copy of each id (~1000 distinct ids across millions of entries).
 *  Grows only: a cached point may still index any id it holds. */
export class WealthIdTable {
  private readonly _index = new Map<string, number>();
  private readonly _ids: string[] = [];

  intern(id: string): number {
    let index = this._index.get(id);
    if (index === undefined) {
      index = this._ids.length;
      this._ids.push(id);
      this._index.set(id, index);
    }
    return index;
  }

  idAt(index: number): string {
    return this._ids[index];
  }

  get size(): number {
    return this._ids.length;
  }
}

/** A point's breakdown reduced to what re-valuing it needs: the ids and
 *  per-item gross of its positive-qty items (the Item Breakdown's rows),
 *  parallel. Immutable — a stored row never changes. */
export interface CompactWealthPoint {
  /** The stored gross value: what a point without per-item detail displays. */
  readonly storedValue: number;
  /** False for an empty or unparseable breakdown: the point shows `storedValue`. */
  readonly detailed:    boolean;
  /** The table `items` indexes into. */
  readonly idTable:     WealthIdTable;
  /** Each item's id as an `idTable` index, parallel to `gross`. */
  readonly items:       Int32Array;
  readonly gross:       Float64Array;
}

function isEntry(e: unknown): e is WealthBreakdownEntry {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return false;
  const {qty, price} = e as Record<string, unknown>;
  return Number.isFinite(qty) && Number.isFinite(price);
}

/** Parses a stored breakdown column. Null — unparseable, so the point shows
 *  its stored value — unless it is a JSON object whose every value is an entry
 *  with finite numeric `qty` and `price`: one bad entry makes the whole
 *  reading untrustworthy, so it is not valued from the rest. */
export function parseWealthBreakdown(json: string): WealthBreakdown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return Object.values(parsed).every(isEntry) ? parsed as WealthBreakdown : null;
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

/** Same rule as the rows: a qty ≤ 0 entry counts for nothing. Ids are interned
 *  into `idTable`; an owner caching many points passes its one table. */
export function compactWealthPoint(
  storedValue: number,
  breakdown:   WealthBreakdown | null,
  idTable:     WealthIdTable = new WealthIdTable(),
): CompactWealthPoint {
  const entries = breakdown ? Object.entries(breakdown) : [];
  let positive = 0;
  for (let i = 0; i < entries.length; i++) if (entries[i][1].qty > 0) positive++;
  // Plain loops: this runs over every cached entry (~1.4 M on real data).
  const items = new Int32Array(positive);
  const gross = new Float64Array(positive);
  for (let i = 0, j = 0; i < entries.length; i++) {
    const [id, e] = entries[i];
    if (!(e.qty > 0)) continue;
    items[j] = idTable.intern(id);
    gross[j++] = taxedValue(e.qty, e.price, undefined, NO_TAX);
  }
  return {storedValue, detailed: entries.length > 0, idTable, items, gross};
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

/** An item's raw type when included; null when hidden. */
type Resolved = {rawType: string | undefined} | null;

/** `compactPointValue` for many points under one policy: each item's
 *  inclusion and type are resolved once, not once per point. */
export function wealthValuer(v: WealthValuation): (point: CompactWealthPoint) => number {
  const included = wealthInclusion(v);
  const resolve  = (id: string): Resolved => (included(id) ? {rawType: v.rawTypeOf(id)} : null);
  // Per id table: index → its resolution, a hole until first met.
  const byTable = new Map<WealthIdTable, Resolved[]>();
  let table: WealthIdTable | null = null;
  let memo: Resolved[] = [];
  return point => {
    if (!point.detailed) return point.storedValue;
    if (point.idTable !== table) {
      table = point.idTable;
      memo  = byTable.get(table) ?? [];
      byTable.set(table, memo);
    }
    let total = 0;
    for (let i = 0; i < point.items.length; i++) {
      const k = point.items[i];
      let r = memo[k];
      if (r === undefined) r = memo[k] = resolve(table.idAt(k));
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
