import type {DbItem, DbSession} from '@/shared/contracts/db';
import type {Source} from '@/shared/contracts/engine';
import type {ItemType} from '@/shared/items';
import {ITEM_TYPES, mapRawType} from '@/shared/items';
import type {
  ClassifiedRow, ConsumedItemRow, DroppedItemRow, FoldedRow, PriceLookup, SourceSlice, TypeSlice, Valuation,
} from './types';
import {ZERO_VAL, addVal, clampVal, isZeroVal, perHour, sharePct, valueItem, valueQty} from '@/domain/valuation';

function nameOf(items: Record<string, DbItem>, id: string): {name: string; known: boolean} {
  const item = items[id];
  return item?.name ? {name: item.name, known: true} : {name: `#${id}`, known: false};
}

/** Normalises rather than casting: the items.type column can hold an unmapped
 *  raw name (e.g. 'Corrosion Material') written by an API lookup or a batch
 *  import, which a bare cast would bucket as its own bogus type. */
function typeOf(items: Record<string, DbItem>, id: string): ItemType {
  return mapRawType(items[id]?.type);
}

/** Winning source for one item, by quantity. Null for legacy sessions, whose
 *  dropsBySource is empty and whose per-item ownership can't be reconstructed. */
function topSourceFor(dropsBySource: DbSession['dropsBySource'], itemId: string): Source | null {
  let best: Source | null = null;
  let bestQty = 0;
  for (const [source, bucket] of Object.entries(dropsBySource ?? {})) {
    const qty = bucket?.[itemId] ?? 0;
    if (qty > bestQty) { bestQty = qty; best = source as Source; }
  }
  return best;
}

/** `session.drops` is the session tier's own accumulator, not a sum over rows
 *  (docs/LOOT-FLOW.md) — era-agnostic, so no attribution branch. maps-per-drop
 *  divides by `mapCount`, never the row count: standalone seasonal runs take a
 *  map_index without being maps. */
export function computeDropped(
  session: DbSession,
  items: Record<string, DbItem>,
  prices: PriceLookup,
  totalSeconds: number,
): DroppedItemRow[] {
  const rows = Object.entries(session.drops ?? {})
    .map(([itemId, qty]) => ({itemId, qty, total: valueItem(prices, itemId, qty)}));
  // Shares are of the positive parts, so a conversion row reads as a negative
  // share rather than inflating everything else's.
  const positiveTotal = rows.reduce((sum, r) => addVal(sum, clampVal(r.total)), ZERO_VAL);

  return rows
    .map(({itemId, qty, total}) => {
      const {name, known} = nameOf(items, itemId);
      return {
        itemId,
        name,
        known,
        type:      typeOf(items, itemId),
        qty,
        unitPrice: valueItem(prices, itemId, 1),
        total,
        pct:       sharePct(total, positiveTotal),
        perHour:   perHour(total, totalSeconds),
        mapsPerDrop: qty > 0 && session.mapCount > 0 ? session.mapCount / qty : null,
        topSource:   topSourceFor(session.dropsBySource, itemId),
        snapshotMissing: prices.isMissing(itemId),
      };
    })
    .sort((a, b) => b.total.live - a.total.live);
}

/** Consumed-material table. Quantities and the grand total come from
 *  `session.spent`, the same authority as `totals.cost`, so the table always
 *  re-adds to the cost tile; the rows only say how many runs used each item. */
export function computeConsumed(
  session: DbSession,
  classified: ClassifiedRow[],
  items: Record<string, DbItem>,
  prices: PriceLookup,
): ConsumedItemRow[] {
  const runsById = new Map<string, number>();
  for (const c of classified) {
    for (const [id, qty] of Object.entries(c.row.spent ?? {})) {
      if (qty > 0) runsById.set(id, (runsById.get(id) ?? 0) + 1);
    }
  }

  const rows = Object.entries(session.spent ?? {})
    .filter(([, qty]) => qty !== 0)
    .map(([itemId, qty]) => ({itemId, qty, total: valueItem(prices, itemId, qty)}));
  const positiveTotal = rows.reduce((sum, r) => addVal(sum, clampVal(r.total)), ZERO_VAL);

  return rows
    .map(({itemId, qty, total}) => {
      const {name, known} = nameOf(items, itemId);
      return {
        itemId,
        name,
        known,
        type:      typeOf(items, itemId),
        qty,
        unitPrice: valueItem(prices, itemId, 1),
        total,
        pct:       sharePct(total, positiveTotal),
        perMap:    session.mapCount > 0 ? qty / session.mapCount : null,
        runsUsing: runsById.get(itemId) ?? 0,
        snapshotMissing: prices.isMissing(itemId),
      };
    })
    .sort((a, b) => b.total.live - a.total.live);
}

/** Value split by item type, signed: a type the session net-consumed carries
 *  its negative value. */
export function computeByType(
  session: DbSession,
  items: Record<string, DbItem>,
  prices: PriceLookup,
): TypeSlice[] {
  const totals = new Map<ItemType, Valuation>();
  for (const [id, qty] of Object.entries(session.drops ?? {})) {
    const type = typeOf(items, id);
    totals.set(type, addVal(totals.get(type) ?? ZERO_VAL, valueItem(prices, id, qty)));
  }
  return slicesOf(ITEM_TYPES.filter(type => totals.has(type)).map(type => [type, totals.get(type)!] as const))
    .map(({key, value, pct}) => ({type: key, value, pct}));
}

/** Non-zero slices with their signed value, largest first. Shares are of the
 *  positive slices only, so a negative slice stays in the data (never shown as
 *  positive) while proportional visuals skip it. */
function slicesOf<K>(entries: ReadonlyArray<readonly [K, Valuation]>): {key: K; value: Valuation; pct: Valuation}[] {
  const positive = entries.reduce((s, [, v]) => addVal(s, clampVal(v)), ZERO_VAL);
  return entries
    .filter(([, value]) => !isZeroVal(value))
    .map(([key, value]) => ({key, value, pct: sharePct(clampVal(value), positive)}))
    .sort((a, b) => b.value.live - a.value.live);
}

/** Prefers `dropsBySource`, where each drop is booked to exactly one owner so
 *  slices sum to session FE in every era. The legacy per-row fallback reads the
 *  fold — a map's own income is whatever the fold left it — and is sound only
 *  because that era ran one seasonal at a time. */
export function computeBySource(
  session: DbSession,
  folded: FoldedRow[],
  prices: PriceLookup,
): {slices: SourceSlice[]; legacy: boolean} {
  const totals = new Map<Source, Valuation>();
  const add = (source: Source, v: Valuation) => totals.set(source, addVal(totals.get(source) ?? ZERO_VAL, v));
  const legacy = Object.keys(session.dropsBySource ?? {}).length === 0;

  if (!legacy) {
    for (const [source, bucket] of Object.entries(session.dropsBySource)) {
      add(source as Source, valueQty(bucket ?? {}, prices));
    }
  } else {
    for (const f of folded) {
      if (f.row.kind === 'map') add('map', f.ownIncome);
      // An overlap with no seasonal type has no source of its own; it stays
      // with the map it ran in, as it always did here.
      for (const [mechanic, value] of Object.entries(f.bySeasonal)) {
        add((mechanic === 'unknown' ? 'map' : mechanic) as Source, value!);
      }
    }
  }

  const slices = slicesOf([...totals]).map(({key, value, pct}) => ({source: key, value, pct}));
  return {slices, legacy};
}
