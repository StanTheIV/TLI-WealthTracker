import type {DbItem, DbSession, Source} from '@/types/electron';
import type {ItemType} from '@/types/itemType';
import {ITEM_TYPES, mapRawType} from '@/types/itemType';
import type {
  ClassifiedRow, ConsumedItemRow, DroppedItemRow, PriceLookup, SourceSlice, TypeSlice, Valuation,
} from './types';
import {ZERO_VAL, addVal, clampVal, perHour, scaleVal, sharePct} from './valuation';

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

function valueOne(prices: PriceLookup, id: string, qty: number): Valuation {
  return {snapshot: qty * prices.snapshot(id), live: qty * prices.live(id)};
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
  const entries = Object.entries(session.drops ?? {});
  const positiveTotal = entries.reduce(
    (sum, [id, qty]) => (qty > 0 ? addVal(sum, valueOne(prices, id, qty)) : sum), ZERO_VAL,
  );

  return entries
    .map(([itemId, qty]) => {
      const {name, known} = nameOf(items, itemId);
      const total = valueOne(prices, itemId, qty);
      return {
        itemId,
        name,
        known,
        type:      typeOf(items, itemId),
        qty,
        unitPrice: valueOne(prices, itemId, 1),
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

/** Consumed-material table, unioned across every run's `spent`. */
export function computeConsumed(
  classified: ClassifiedRow[],
  items: Record<string, DbItem>,
  prices: PriceLookup,
  mapCount: number,
): ConsumedItemRow[] {
  const qtyById   = new Map<string, number>();
  const runsById  = new Map<string, number>();

  for (const c of classified) {
    for (const [id, qty] of Object.entries(c.row.spent ?? {})) {
      // Costs are positive magnitudes; a negative would be a refund the cost
      // valuator already clamps away, so skip it rather than net it off here
      // and disagree with totals.cost.
      if (qty <= 0) continue;
      qtyById.set(id, (qtyById.get(id) ?? 0) + qty);
      runsById.set(id, (runsById.get(id) ?? 0) + 1);
    }
  }

  const grandTotal = [...qtyById].reduce(
    (sum, [id, qty]) => addVal(sum, valueOne(prices, id, qty)), ZERO_VAL,
  );

  return [...qtyById]
    .map(([itemId, qty]) => {
      const {name, known} = nameOf(items, itemId);
      const total = valueOne(prices, itemId, qty);
      return {
        itemId,
        name,
        known,
        type:      typeOf(items, itemId),
        qty,
        unitPrice: valueOne(prices, itemId, 1),
        total,
        pct:       sharePct(total, grandTotal),
        perMap:    mapCount > 0 ? qty / mapCount : null,
        runsUsing: runsById.get(itemId) ?? 0,
        snapshotMissing: prices.isMissing(itemId),
      };
    })
    .sort((a, b) => b.total.live - a.total.live);
}

/** Value split by item type. Negative quantities are conversions, not income. */
export function computeByType(
  session: DbSession,
  items: Record<string, DbItem>,
  prices: PriceLookup,
): TypeSlice[] {
  const totals = new Map<ItemType, Valuation>();
  for (const [id, qty] of Object.entries(session.drops ?? {})) {
    if (qty <= 0) continue;
    const type = typeOf(items, id);
    totals.set(type, addVal(totals.get(type) ?? ZERO_VAL, valueOne(prices, id, qty)));
  }

  const grand = [...totals.values()].reduce((s, v) => addVal(s, v), ZERO_VAL);
  if (grand.live <= 0 && grand.snapshot <= 0) return [];

  return ITEM_TYPES
    .filter(type => (totals.get(type)?.live ?? 0) > 0)
    .map(type => {
      const value = totals.get(type)!;
      return {type, value, pct: sharePct(value, grand)};
    })
    .sort((a, b) => b.value.live - a.value.live);
}

/** Prefers `dropsBySource`, where each drop is booked to exactly one owner so
 *  slices sum to session FE in every era. The legacy per-row fallback is sound
 *  only because that era ran one seasonal at a time. */
export function computeBySource(
  session: DbSession,
  classified: ClassifiedRow[],
  prices: PriceLookup,
): {slices: SourceSlice[]; legacy: boolean} {
  const totals = new Map<Source, Valuation>();
  const byRow  = Object.keys(session.dropsBySource ?? {}).length === 0;

  if (!byRow) {
    for (const [source, bucket] of Object.entries(session.dropsBySource)) {
      let acc = ZERO_VAL;
      for (const [id, qty] of Object.entries(bucket ?? {})) {
        if (qty > 0) acc = addVal(acc, valueOne(prices, id, qty));
      }
      totals.set(source as Source, addVal(totals.get(source as Source) ?? ZERO_VAL, acc));
    }
  } else {
    for (const c of classified) {
      const source = (c.row.seasonalType ?? 'map') as Source;
      totals.set(source, addVal(totals.get(source) ?? ZERO_VAL, c.income));
      // Only concurrent overlaps dropped through into the parent row, so only
      // they may be subtracted from it — same gate as computeMechanics.
      if (c.kind === 'overlap-seasonal' && c.concurrentWithMap) {
        totals.set('map', addVal(totals.get('map') ?? ZERO_VAL, scaleVal(c.income, -1)));
      }
    }
    // A legacy row set can subtract past zero. Clamp so the map's own income
    // isn't silently deleted from the breakdown.
    const mapTotal = totals.get('map') ?? ZERO_VAL;
    totals.set('map', clampVal(mapTotal));
  }

  const grand = [...totals.values()].reduce((s, v) => addVal(s, clampVal(v)), ZERO_VAL);
  if (grand.live <= 0 && grand.snapshot <= 0) return {slices: [], legacy: byRow};

  const slices = [...totals]
    .filter(([, value]) => value.live > 0)
    .map(([source, value]) => ({source, value, pct: sharePct(value, grand)}))
    .sort((a, b) => b.value.live - a.value.live);

  return {slices, legacy: byRow};
}
