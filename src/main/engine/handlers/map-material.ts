import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {log} from '@/main/logger';

const TOWN_MARKER = 'YuJinZhiXiBiNanSuo';

function isTownScene(scene: string): boolean {
  return scene.includes(TOWN_MARKER);
}

/**
 * MapMaterialHandler — detects map-creation material spends and warns when
 * the player is about to run out.
 *
 * Behavior:
 *   - Town-side negative bag deltas are accumulated into _pendingSpends.
 *   - On a town -> map transition (a real map creation), items in
 *     _pendingSpends advance a streak counter in _watch, and items in
 *     _watch that weren't spent this map are dropped.
 *   - An item becomes "watched" at streak >= 2 (spent on two consecutive
 *     maps). When its current quantity is <= 1 on a map entry, it's
 *     included in the emitted map_material_warning event.
 *   - Map -> map transitions (e.g. into Vorex / Overrealm / seasonal
 *     instances) are NOT map creation events and are ignored — they don't
 *     promote, decay, or emit.
 *   - Dismissed items are suppressed until they recover to qty >= 2.
 *
 * MUST be registered AFTER ZoneHandler and ItemHandler so that ctx.inMap
 * is fresh and BagState deltas have been computed.
 */
export class MapMaterialHandler implements EventHandler {
  readonly name    = 'map-material';
  readonly handles = ['bag_update', 'bag_remove', 'zone_transition'] as const;

  private _pendingSpends: Map<number, number>           = new Map();
  private _watch:         Map<number, {streak: number}> = new Map();
  private _dismissed:     Set<number>                   = new Set();
  /** Items currently emitted as low-stock — used to detect new low events for logging. */
  private _activeLow:     Set<number>                   = new Set();
  /** Item qty <= _threshold triggers a warning. Default 0 (warn only at 0). */
  private _threshold:     number                        = 0;
  /** Snapshot of the materials spent on the most recent map entry. Cleared
   *  on each new map entry, so consumers should read it on map exit. */
  private _lastSpends:    Map<number, number>           = new Map();

  /** Returns the materials spent (positive quantities) on the most recent
   *  town -> map entry. Read on map exit / session save. */
  getLastSpends(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, qty] of this._lastSpends) {
      // _pendingSpends accumulates negative deltas; flip sign for export.
      if (qty < 0) out[String(id)] = -qty;
    }
    return out;
  }

  onStop(): void {
    this._pendingSpends.clear();
    this._watch.clear();
    this._dismissed.clear();
    this._activeLow.clear();
    this._lastSpends.clear();
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    if (event.type === 'bag_update' || event.type === 'bag_remove') {
      const deltas = ctx.bag.getLastDeltas();
      let recovered = false;
      for (const d of deltas) {
        if (d.change < 0 && !ctx.inMap) {
          // Only town-side negative deltas count as map-creation spends.
          this._pendingSpends.set(d.itemId, (this._pendingSpends.get(d.itemId) ?? 0) + d.change);
        } else if (d.change > 0) {
          // Positive delta — may be restock in town or an in-map pickup.
          if (!ctx.inMap) {
            // Net against pending town spends (e.g. restock during sort).
            const current = this._pendingSpends.get(d.itemId);
            if (current !== undefined) {
              const next = current + d.change;
              if (next >= 0) this._pendingSpends.delete(d.itemId);
              else           this._pendingSpends.set(d.itemId, next);
            }
          }
          // Any positive delta that brings a watched item to >= 2 clears its
          // dismissal and triggers a live warning refresh.
          if (this._watch.has(d.itemId) && ctx.bag.getTotalForItem(d.itemId) >= 2) {
            this._dismissed.delete(d.itemId);
            recovered = true;
          }
        }
      }
      if (recovered) this._emitWarnings(ctx, emit);
      return;
    }

    if (event.type === 'zone_transition') {
      const fromTown = isTownScene(event.fromScene);
      const toTown   = isTownScene(event.toScene);

      if (ctx.inMap && fromTown) {
        // Real map creation: town -> map. Run promotion / decay / warning.
        this._onMapEntry(ctx, emit);
      } else if (toTown) {
        // Returned to town. Drop any pending spends so post-map town activity
        // attributes to the next map's creation.
        this._pendingSpends.clear();
      }
      // Else: map -> map (seasonal entry, etc.) — leave watch state alone.
    }
  }

  private _onMapEntry(ctx: EngineContext, emit: EmitFn): void {
    // Snapshot the spends for this map entry — consumers (e.g. the engine
    // emit callback writing per-map history) read this on map exit.
    this._lastSpends = new Map(this._pendingSpends);

    const spent = new Set(this._pendingSpends.keys());

    // Promotion.
    for (const itemId of spent) {
      const entry = this._watch.get(itemId);
      const nextStreak = entry ? entry.streak + 1 : 1;
      this._watch.set(itemId, {streak: nextStreak});
      // Newly added to the watchlist (first time the streak hit 2 — i.e.
      // the item became "tracked as a recurring map material").
      if (nextStreak === 2) {
        log.info('engine', `Map material added to tracking: itemId=${itemId}`);
      }
    }

    // Decay — items that broke their streak leave the watchlist, and their
    // dismissal is cleared so a fresh return can re-warn.
    for (const itemId of [...this._watch.keys()]) {
      if (!spent.has(itemId)) {
        const wasTracked = (this._watch.get(itemId)?.streak ?? 0) >= 2;
        this._watch.delete(itemId);
        this._dismissed.delete(itemId);
        this._activeLow.delete(itemId);
        if (wasTracked) {
          log.info('engine', `Map material removed from tracking: itemId=${itemId}`);
        }
      }
    }

    this._emitWarnings(ctx, emit);
    this._pendingSpends.clear();
  }

  /** Build and emit the current warning list from _watch + bag state. */
  private _emitWarnings(ctx: EngineContext, emit: EmitFn): void {
    const warnings: Array<{itemId: number; quantity: number}> = [];
    const nowLow    = new Set<number>();
    for (const [itemId, {streak}] of this._watch) {
      if (streak < 2) continue;
      if (this._dismissed.has(itemId)) continue;
      const qty = ctx.bag.getTotalForItem(itemId);
      if (qty <= this._threshold) {
        warnings.push({itemId, quantity: qty});
        nowLow.add(itemId);
        // Log only on the transition into the low state (avoid spam when
        // the warning re-emits on every map entry while still low).
        if (!this._activeLow.has(itemId)) {
          log.info('engine', `Map material low-stock detected: itemId=${itemId} qty=${qty} threshold=${this._threshold}`);
        }
      }
    }
    this._activeLow = nowLow;
    emit({type: 'map_material_warning', items: warnings, timestamp: Date.now()});
  }

  /** Called via IPC when the user clicks dismiss on a warning row. */
  dismiss(itemId: number): void {
    this._dismissed.add(itemId);
  }

  /** Update the qty threshold at/under which warnings fire. Default is 0. */
  setThreshold(n: number): void {
    const next = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    if (next === this._threshold) return;
    this._threshold = next;
    log.info('engine', `Low-stock threshold set: ${next}`);
  }
}
