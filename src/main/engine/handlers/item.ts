import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {publishDrops} from '@/main/engine/drop-publisher';

const BUFFER_MS = 1500;

/**
 * ItemHandler — tracks inventory changes and emits drop events.
 *
 * Buffer behavior, by `ctx.isLootContext()` (where the player is — a map, a
 * seasonal scene or the Sandlord hub — not which trackers exist):
 *   - In a loot context: every bag delta flushes immediately, distributed to
 *     session / map / seasonal.
 *   - Elsewhere (town, or an unrecognised scene): deltas accumulate in a
 *     buffer, even with a seasonal panel open. The buffer is town activity and
 *     is never credited as loot. It ends either:
 *       a) when the 1500ms timer fires (settled town activity → discarded), or
 *       b) at the next zone_transition. If that transition is town → a freshly
 *          started map, the buffer's NEGATIVES are the map's entry cost (the
 *          materials consumed right before it — see docs/GAMEPLAY.md): booked
 *          via `registry.chargeEntryCost` onto the map tracker and the
 *          session's running total, never as negative drops. Its positives,
 *          and every buffer at any other transition (town → seasonal scene,
 *          town → hub, …), are discarded.
 *     Either way `new_item` still fires for a first-seen id, and BagState's
 *     baselines have already advanced, so discarding never desynchronises
 *     later in-map deltas.
 *
 * Timer rule: the 1500ms is a max-wait from the FIRST town event, not a
 * sliding window from the last. This prevents a long sequence of small town
 * changes from indefinitely deferring the flush and leaking into the next map.
 * A spend that settled before the map entry is therefore not its cost.
 */
export class ItemHandler implements EventHandler {
  readonly name    = 'item';
  readonly handles = ['bag_update', 'bag_remove', 'zone_transition'] as const;

  // itemId → net change since last flush
  private _buffer: Map<number, number> = new Map();
  private _timer:  ReturnType<typeof setTimeout> | null = null;

  onStop(_ctx: EngineContext): void {
    this._clearTimer();
    this._buffer.clear();
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;

    if (event.type === 'bag_update' || event.type === 'bag_remove') {
      // Bookkeeping is structural and runs even while paused (as a paused
      // resort does), so BagState's slots always match the bag — skipping it
      // would leave a stale slot whose first post-resume change credits
      // everything picked up during the pause. Only crediting is paused:
      // BagState has already advanced its baseline past these deltas.
      const changes = event.type === 'bag_update'
        ? ctx.bag.processUpdate(event.pageId, event.slotId, event.itemId, event.quantity)
        : ctx.bag.processRemove(event.pageId, event.slotId);
      ctx.bagDeltas = changes;
      if (ctx.paused) return;

      for (const change of changes) {
        this._buffer.set(change.itemId, (this._buffer.get(change.itemId) ?? 0) + change.change);
      }
      this._scheduleFlush(ctx, emit);
      return;
    }

    // A zone_transition is structural, but while paused its buffer holds town
    // deltas that must neither be credited nor charged across the transition —
    // discard so they can't leak into the next map on resume. A map entered
    // paused therefore has no entry cost.
    if (ctx.paused) {
      if (event.type === 'zone_transition') {
        this._clearTimer();
        this._buffer.clear();
      }
      return;
    }

    if (event.type === 'zone_transition') {
      // ZoneHandler ran first, so ctx.prevLocation / ctx.transition describe
      // THIS transition and a freshly started map tracker already exists.
      this._clearTimer();
      if (this._buffer.size === 0) return;
      const buffer = this._buffer;
      this._buffer = new Map();
      // Town activity: credits nothing, but first-seen ids still register.
      publishDrops(ctx, emit, buffer, {lootContext: false});
      if (ctx.prevLocation === 'town' && ctx.transition?.mapStarted) {
        this._chargeEntryCost(ctx, emit, buffer);
      }
    }
  }

  /** The buffer's negatives, flipped to magnitudes, become the new map's cost. */
  private _chargeEntryCost(ctx: EngineContext, emit: EmitFn, buffer: ReadonlyMap<number, number>): void {
    const cost = new Map<number, number>();
    for (const [itemId, change] of buffer) if (change < 0) cost.set(itemId, -change);
    if (cost.size === 0) return;

    ctx.registry.chargeEntryCost(cost);
    const now = Date.now();
    if (ctx.registry.map)     emit({type: 'tracker_update', tracker: ctx.registry.map.snapshot(),     timestamp: now});
    if (ctx.registry.session) emit({type: 'tracker_update', tracker: ctx.registry.session.snapshot(), timestamp: now});
  }

  private _scheduleFlush(ctx: EngineContext, emit: EmitFn): void {
    if (ctx.isLootContext()) {
      this._flush(ctx, emit, /*lootContext*/ true); // immediate in-map flush
      return;
    }
    // In town: set the timer once on the first buffered event; subsequent
    // events extend the buffer but do NOT restart the timer. Max wait from
    // first event = BUFFER_MS, regardless of how many events follow.
    if (this._timer === null) {
      this._timer = setTimeout(() => this._flush(ctx, emit, /*lootContext*/ false), BUFFER_MS);
    }
  }

  /** Publish and clear the buffer — as loot only for an immediate in-loot-context flush. */
  private _flush(ctx: EngineContext, emit: EmitFn, lootContext: boolean): void {
    this._clearTimer();
    if (this._buffer.size === 0) return;
    publishDrops(ctx, emit, this._buffer, {lootContext});
    this._buffer.clear();
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
