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
 * Dual-baseline:
 *   _initialBaselines — frozen at finishInit(), never changes
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
  private _initialBaselines = new Map<number, number>();
  private _baseline = new Map<number, number>();
  private _initialized = false;
  private _lastDeltas: SlotChange[] = [];

  get initialized(): boolean { return this._initialized; }
  get slotCount():   number  { return this._slots.size; }
  get itemCount():   number  { return this._initialBaselines.size; }

  // ---------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------

  /** Called during init phase for each bag_init event. */
  processInit(pageId: number, slotId: number, itemId: number, quantity: number): void {
    const key = slotKey(pageId, slotId);
    this._slots.set(key, {itemId, quantity});
    this._addToTotal(itemId, quantity);
  }

  /** Freeze baselines after all bag_init events are received. */
  finishInit(): void {
    this._initialBaselines = new Map(this._totals);
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
  processResort(entries: SlotSnapshotEntry[]): SlotChange[] {
    if (!this._initialized) return [];

    // Rebuild slots and totals from scratch
    const newSlots  = new Map<string, Slot>();
    const newTotals = new Map<number, number>();
    for (const e of entries) {
      newSlots.set(slotKey(e.pageId, e.slotId), {itemId: e.itemId, quantity: e.quantity});
      if (e.quantity !== 0) {
        newTotals.set(e.itemId, (newTotals.get(e.itemId) ?? 0) + e.quantity);
      }
    }

    this._slots  = newSlots;
    this._totals = newTotals;

    // Compare every item present in either new totals or old baseline
    const touched = new Set<number>([...newTotals.keys(), ...this._baseline.keys()]);
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

  /**
   * The SlotChange[] returned by the most recent processUpdate/processRemove/
   * processResort call. Lets a second handler consume the same deltas that
   * ItemHandler already processed, without re-applying them.
   */
  getLastDeltas(): SlotChange[] {
    return this._lastDeltas;
  }

  reset(): void {
    this._slots.clear();
    this._totals.clear();
    this._initialBaselines.clear();
    this._baseline.clear();
    this._initialized = false;
    this._lastDeltas  = [];
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

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
    this._lastDeltas = out;
    return out;
  }
}

function slotKey(pageId: number, slotId: number): string {
  return `${pageId}_${slotId}`;
}
