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
 * Watchlist signal: town-side negative bag deltas accumulate per-item in
 * `_pendingSpends`; positive town deltas net against existing negatives only
 * (asymmetric — a pickup that comes BEFORE any spend doesn't pre-empt the
 * later spend, but a pickup that comes AFTER a spend cancels it out). On a
 * town→map transition, items still in `_pendingSpends` advance their
 * `_watch` streak; items in `_watch` not present drop off.
 *
 * IMPORTANT: this watchlist signal is independent of `m.spent`, which comes
 * from `ItemHandler.getLastPreMapFlush()` and reflects the net buffer at
 * map-entry time. The watchlist's order-asymmetric netting is more
 * forgiving (a pickup-then-spend still counts as a spend, so the player gets
 * warned about recurring map material consumption) — the chart's `m.spent`
 * is strictly net (so a buy-and-spend in the same window shows zero cost).
 *
 * AH listings, vault deposits, etc. WILL briefly appear in `_pendingSpends`
 * for the next map's promotion, reaching streak=1. The 2+ consecutive-map
 * threshold ensures one-off listings never fire a low-stock warning.
 *
 * Behavior:
 *   - Town-side negative bag deltas accumulated into `_pendingSpends`.
 *   - On a town→map transition: items in `_pendingSpends` advance streak;
 *     items in `_watch` not in `_pendingSpends` decay; emits a warning
 *     snapshot for watched items at qty <= threshold.
 *   - On `bag_update` / `bag_remove` (positive deltas): if a watched item's
 *     qty recovers to >= 2, dismissal clears and a fresh warning fires.
 *   - Map → map transitions are NOT map creation events and are ignored.
 *   - Dismissed items are suppressed until they recover to qty >= 2.
 *
 * MUST be registered AFTER ZoneHandler so `ctx.inMap` reflects the current
 * scene before this handler runs.
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

  onStop(): void {
    this._pendingSpends.clear();
    this._watch.clear();
    this._dismissed.clear();
    this._activeLow.clear();
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    if (event.type === 'bag_update' || event.type === 'bag_remove') {
      const deltas = ctx.bag.getLastDeltas();
      let recovered = false;
      for (const d of deltas) {
        if (d.change < 0 && !ctx.inMap) {
          // Town-side negative → accumulate as pending spend.
          this._pendingSpends.set(d.itemId, (this._pendingSpends.get(d.itemId) ?? 0) + d.change);
        } else if (d.change > 0) {
          // Positive delta — net against existing town pending spend (cancel
          // a previously-recorded spend if the player restocked it). Don't
          // pre-empt a future spend with an earlier pickup — only net if
          // there's already a pending negative for this item.
          if (!ctx.inMap) {
            const current = this._pendingSpends.get(d.itemId);
            if (current !== undefined) {
              const next = current + d.change;
              if (next >= 0) this._pendingSpends.delete(d.itemId);
              else           this._pendingSpends.set(d.itemId, next);
            }
          }
          // Any positive delta that brings a watched item to >= 2 clears
          // its dismissal and triggers a live warning refresh — works in
          // both town (restock) and in-map (loot pickup).
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
        // Real map creation: town → map. Run promotion / decay / warning.
        this._onMapEntry(ctx, emit);
      } else if (toTown) {
        // Returned to town. Drop any pending spends so post-map town
        // activity attributes to the next map's creation.
        this._pendingSpends.clear();
      }
      // Else: map → map (seasonal entry, etc.) — leave watch state alone.
    }
  }

  private _onMapEntry(ctx: EngineContext, emit: EmitFn): void {
    const spent = new Set(this._pendingSpends.keys());

    // Promotion.
    for (const itemId of spent) {
      const entry      = this._watch.get(itemId);
      const nextStreak = entry ? entry.streak + 1 : 1;
      this._watch.set(itemId, {streak: nextStreak});
      if (nextStreak === 2) {
        log.info('engine', `Map material added to tracking: itemId=${itemId}`);
      }
    }

    // Decay — items that broke their streak leave the watchlist.
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
