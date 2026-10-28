import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {log} from '@/main/logger';
import type {Settings} from '@/shared/settings';
import type {EngineEvent} from '@/shared/contracts/engine';

type LowStockItem = Extract<EngineEvent, {type: 'map_material_warning'}>['items'][number];

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
 * IMPORTANT: this watchlist signal is independent of the map's entry cost
 * (`TrackerSnapshot.spent`), which ItemHandler charges from the net town
 * buffer at map entry. The watchlist's order-asymmetric netting is more
 * forgiving (a pickup-then-spend still counts as a spend, so the player gets
 * warned about recurring map material consumption) — the entry cost is
 * strictly net (so a buy-and-spend in the same window shows zero cost).
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
 * MUST be registered AFTER ZoneHandler so `ctx.location` / `ctx.transition`
 * reflect the current scene before this handler runs.
 */
export class MapMaterialHandler implements EventHandler {
  readonly name    = 'map-material';
  readonly handles = ['bag_update', 'bag_remove', 'zone_transition'] as const;

  private _pendingSpends: Map<number, number>           = new Map();
  private _watch:         Map<number, {streak: number}> = new Map();
  private _dismissed:     Set<number>                   = new Set();
  /** The last emitted warning list — what the renderer shows (bag changes
   *  between emissions do not republish it). */
  private _published:     LowStockItem[]                = [];
  /** Item qty <= _threshold triggers a warning. Default 0 (warn only at 0). */
  private _threshold:     number                        = 0;

  onStop(): void {
    this._pendingSpends.clear();
    this._watch.clear();
    this._dismissed.clear();
    this._published = [];
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Fully paused-guarded: this is analytical spend-tracking, not run lifecycle.
    // No paused spends should count toward the low-stock watchlist, and there is
    // no seasonal/map structure to tear down here.
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    if (event.type === 'bag_update' || event.type === 'bag_remove') {
      const deltas = ctx.bagDeltas;
      // Only town-side spends are map-cost candidates — only normal maps have
      // a cost; spending inside a seasonal scene or the hub is not one. Not
      // `location === 'town'`: until the first transition the location is the
      // initial 'other' although the player is normally in town, and spends
      // there must count for the first map. (A real unrecognised scene can't
      // leak: only a town → map entry promotes, and reaching town clears.)
      const townSide = !ctx.isLootContext();
      let recovered = false;
      for (const d of deltas) {
        if (d.change < 0 && townSide) {
          // Town-side negative → accumulate as pending spend.
          this._pendingSpends.set(d.itemId, (this._pendingSpends.get(d.itemId) ?? 0) + d.change);
        } else if (d.change > 0) {
          // Positive delta — net against existing town pending spend (cancel
          // a previously-recorded spend if the player restocked it). Don't
          // pre-empt a future spend with an earlier pickup — only net if
          // there's already a pending negative for this item.
          if (townSide) {
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
      // ZoneHandler ran first, so ctx.transition describes THIS event.
      if (ctx.prevLocation === 'town' && ctx.transition?.mapStarted) {
        // Real map creation: town → a freshly started map. Run promotion /
        // decay / warning. Seasonal scenes and the hub never start a map.
        this._onMapEntry(ctx, emit);
      } else if (ctx.location === 'town') {
        // Returned to town. Drop any pending spends so post-map town
        // activity attributes to the next map's creation.
        this._pendingSpends.clear();
      }
      // Else: map → seasonal scene / hub and back, etc. — leave watch state alone.
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
        if (wasTracked) {
          log.info('engine', `Map material removed from tracking: itemId=${itemId}`);
        }
      }
    }

    this._emitWarnings(ctx, emit);
    this._pendingSpends.clear();
  }

  /** The current warning list: tracked (streak ≥ 2), not dismissed, at or
   *  under the threshold. Pure — reads _watch, _dismissed and the bag. */
  private _warnings(ctx: EngineContext): LowStockItem[] {
    const warnings: LowStockItem[] = [];
    for (const [itemId, {streak}] of this._watch) {
      if (streak < 2 || this._dismissed.has(itemId)) continue;
      const qty = ctx.bag.getTotalForItem(itemId);
      if (qty <= this._threshold) warnings.push({itemId, quantity: qty});
    }
    return warnings;
  }

  /** Emit the current warning list, logging each item that just went low. */
  private _emitWarnings(ctx: EngineContext, emit: EmitFn): void {
    const warnings = this._warnings(ctx);
    const wasLow   = new Set(this._published.map(w => w.itemId));
    for (const {itemId, quantity} of warnings) {
      if (!wasLow.has(itemId)) {
        log.info('engine', `Map material low-stock detected: itemId=${itemId} qty=${quantity} threshold=${this._threshold}`);
      }
    }
    this._published = warnings;
    emit({type: 'map_material_warning', items: warnings, timestamp: Date.now()});
  }

  /** The published list minus what the user dismissed since (the renderer
   *  hides those rows itself), when anything is left to show. */
  replay(ctx: EngineContext): EngineEvent[] {
    if (ctx.phase !== 'tracking') return [];
    const items = this._published.filter(w => !this._dismissed.has(w.itemId)).map(w => ({...w}));
    return items.length > 0 ? [{type: 'map_material_warning', items, timestamp: Date.now()}] : [];
  }

  /** Called via IPC when the user clicks dismiss on a warning row. */
  dismiss(itemId: number): void {
    this._dismissed.add(itemId);
  }

  /** `lowStockThreshold`: the qty at/under which warnings fire. Applies live
   *  (watch state is kept). */
  configure(settings: Settings): void {
    const next = settings.lowStockThreshold;
    if (next === this._threshold) return;
    this._threshold = next;
    log.info('engine', `Low-stock threshold set: ${next}`);
  }
}
