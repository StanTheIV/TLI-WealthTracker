/**
 * BagState — tracks per-item inventory totals with slot-level bookkeeping.
 *
 * Core invariant: `_totals` is the single source of truth for "how many of
 * item X are in the inventory right now". Slot-level events (add/update/remove)
 * maintain it incrementally. `_slots` is bookkeeping — only used to know what
 * an individual slot previously held.
 *
 * Delta detection compares `_totals` against `_baseline` (last-reported totals)
 * so it never depends on iterating `_slots`. This means a stale `_slots` entry
 * cannot corrupt delta computation.
 *
 * Baselines:
 *   _initialItemCount — distinct items at init(), frozen (reported as itemCount)
 *   _baseline         — updated after each emitted delta, avoids double-counting
 */

export interface SlotChange {
  itemId: number;
  change: number; // positive = gained, negative = lost
}

export interface SlotSnapshotEntry {
  pageId:   number;
  slotId:   number;
  itemId:   number;
  quantity: number;
}

type Slot = {itemId: number; quantity: number};

export class BagState {
  private _slots   = new Map<string, Slot>();
  private _totals  = new Map<number, number>();
  private _initialItemCount = 0;
  private _baseline = new Map<number, number>();
  private _initialized = false;

  get initialized(): boolean { return this._initialized; }
  get slotCount():   number  { return this._slots.size; }
  get itemCount():   number  { return this._initialItemCount; }

  // ---------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------

  /** Take a full bag dump as the starting inventory and freeze the baselines. */
  init(entries: Iterable<SlotSnapshotEntry>): void {
    this._load(entries);
    this._initialItemCount = this._totals.size;
    this._baseline         = new Map(this._totals);
    this._initialized      = true;
  }

  // ---------------------------------------------------------------------
  // Runtime slot mutations
  // ---------------------------------------------------------------------

  processUpdate(pageId: number, slotId: number, itemId: number, quantity: number): SlotChange[] {
    if (!this._initialized) return [];

    const key  = slotKey(pageId, slotId);
    const prev = this._slots.get(key);

    const touched = new Set<number>();

    if (prev) {
      this._addToTotal(prev.itemId, -prev.quantity);
      touched.add(prev.itemId);
    }
    this._slots.set(key, {itemId, quantity});
    this._addToTotal(itemId, quantity);
    touched.add(itemId);

    return this._diffTouched(touched);
  }

  processRemove(pageId: number, slotId: number): SlotChange[] {
    if (!this._initialized) return [];

    const key  = slotKey(pageId, slotId);
    const prev = this._slots.get(key);
    if (!prev) return [];

    this._slots.delete(key);
    this._addToTotal(prev.itemId, -prev.quantity);

    return this._diffTouched(new Set([prev.itemId]));
  }

  /**
   * Apply a full slot snapshot (e.g. after an in-game resort). Replaces the
   * entire slot layout, rebuilds totals, and returns deltas for any item whose
   * aggregate quantity genuinely changed.
   *
   * Pure resorts (slots shuffled, totals conserved) return an empty array.
   */
  processResort(entries: Iterable<SlotSnapshotEntry>): SlotChange[] {
    if (!this._initialized) return [];
    this._load(entries);
    // Compare every item present in either new totals or old baseline
    const touched = new Set<number>([...this._totals.keys(), ...this._baseline.keys()]);
    return this._diffTouched(touched);
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  getTotalForItem(itemId: number): number {
    return this._totals.get(itemId) ?? 0;
  }

  getInventory(): Map<number, number> {
    return new Map(this._totals);
  }

  /** Copy of the slot layout, keyed `pageId_slotId` — for consistency checks. */
  getSlots(): Map<string, Readonly<Slot>> {
    return new Map(this._slots);
  }

  reset(): void {
    this._slots.clear();
    this._totals.clear();
    this._initialItemCount = 0;
    this._baseline.clear();
    this._initialized = false;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** Replace the slot layout with a full dump and rebuild totals from it.
   *  Totals are summed over the de-duplicated slot map, never over the raw
   *  entries: a slot listed twice must count once, or every stack doubles. */
  private _load(entries: Iterable<SlotSnapshotEntry>): void {
    const slots = new Map<string, Slot>();
    for (const e of entries) slots.set(slotKey(e.pageId, e.slotId), {itemId: e.itemId, quantity: e.quantity});
    const totals = new Map<number, number>();
    for (const s of slots.values()) {
      if (s.quantity !== 0) totals.set(s.itemId, (totals.get(s.itemId) ?? 0) + s.quantity);
    }
    this._slots  = slots;
    this._totals = totals;
  }

  private _addToTotal(itemId: number, delta: number): void {
    const next = (this._totals.get(itemId) ?? 0) + delta;
    if (next === 0) this._totals.delete(itemId);
    else            this._totals.set(itemId, next);
  }

  private _diffTouched(itemIds: Iterable<number>): SlotChange[] {
    const out: SlotChange[] = [];
    for (const itemId of itemIds) {
      const total    = this._totals.get(itemId)  ?? 0;
      const baseline = this._baseline.get(itemId) ?? 0;
      const change   = total - baseline;
      if (change === 0) continue;

      if (total === 0) this._baseline.delete(itemId);
      else             this._baseline.set(itemId, total);
      out.push({itemId, change});
    }
    return out;
  }
}

/** Identity of one inventory slot. Shared so every dump reader keys slots alike. */
export function slotKey(pageId: number, slotId: number): string {
  return `${pageId}_${slotId}`;
}
