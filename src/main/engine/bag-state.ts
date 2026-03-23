/**
 * BagState — tracks inventory slot contents and computes item deltas.
 *
 * Port of Python's core/models/bag_state.py.
 *
 * Dual-baseline system:
 *   _initialBaselines  — set once when init completes, never changes.
 *                        Used to compute session totals.
 *   _workingBaselines  — updated after each recorded change.
 *                        Used to avoid double-counting the same quantity.
 */

export interface SlotChange {
  itemId: number;
  change: number; // positive = gained, negative = lost
}

export class BagState {
  // slotKey → {itemId, quantity}
  private _slots = new Map<string, {itemId: number; quantity: number}>();
  // itemId → total quantity across all slots
  private _initialBaselines = new Map<number, number>();
  private _workingBaselines = new Map<number, number>();
  private _initialized = false;

  get initialized(): boolean {
    return this._initialized;
  }

  get slotCount(): number {
    return this._slots.size;
  }

  get itemCount(): number {
    return this._initialBaselines.size;
  }

  // Called during the init phase — populate slot contents
  processInit(pageId: number, slotId: number, itemId: number, quantity: number): void {
    const key = `${pageId}_${slotId}`;
    this._slots.set(key, {itemId, quantity});
  }

  // Freeze baselines — call once after all bag_init events are received
  finishInit(): void {
    // Aggregate totals per item across all slots
    const totals = new Map<number, number>();
    for (const {itemId, quantity} of this._slots.values()) {
      totals.set(itemId, (totals.get(itemId) ?? 0) + quantity);
    }
    this._initialBaselines = new Map(totals);
    this._workingBaselines = new Map(totals);
    this._initialized = true;
  }

  // Called on bag_update events during active tracking
  // Returns the net changes for affected items (may include old item if slot contents changed)
  processUpdate(pageId: number, slotId: number, itemId: number, quantity: number): SlotChange[] {
    if (!this._initialized) return [];

    const key = `${pageId}_${slotId}`;
    const prev = this._slots.get(key);

    // Update slot
    this._slots.set(key, {itemId, quantity});

    const changes: SlotChange[] = [];

    // If slot previously held a different item, compute its change too
    if (prev && prev.itemId !== itemId) {
      const oldChange = this._computeChange(prev.itemId);
      if (oldChange) changes.push(oldChange);
    }

    const newChange = this._computeChange(itemId);
    if (newChange) changes.push(newChange);

    return changes;
  }

  // Called on bag_remove events
  processRemove(pageId: number, slotId: number): SlotChange[] {
    if (!this._initialized) return [];

    const key = `${pageId}_${slotId}`;
    const slot = this._slots.get(key);
    if (!slot) return [];

    this._slots.delete(key);
    const change = this._computeChange(slot.itemId);
    return change ? [change] : [];
  }

  // Get current total quantity of an item across all slots
  getTotalForItem(itemId: number): number {
    let total = 0;
    for (const slot of this._slots.values()) {
      if (slot.itemId === itemId) total += slot.quantity;
    }
    return total;
  }

  // Returns current total quantity of every item across all slots
  getInventory(): Map<number, number> {
    const totals = new Map<number, number>();
    for (const {itemId, quantity} of this._slots.values()) {
      totals.set(itemId, (totals.get(itemId) ?? 0) + quantity);
    }
    return totals;
  }

  reset(): void {
    this._slots.clear();
    this._initialBaselines.clear();
    this._workingBaselines.clear();
    this._initialized = false;
  }

  private _computeChange(itemId: number): SlotChange | null {
    const currentTotal = this.getTotalForItem(itemId);
    const baseline = this._workingBaselines.get(itemId) ?? 0;
    const change = currentTotal - baseline;

    if (change === 0) return null;

    // Update working baseline so next event doesn't double-count
    this._workingBaselines.set(itemId, currentTotal);
    return {itemId, change};
  }
}
