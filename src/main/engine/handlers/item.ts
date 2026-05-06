import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {publishDrops, type PublishMode} from '@/main/engine/drop-publisher';

const BUFFER_MS = 1500;

/**
 * ItemHandler — tracks inventory changes and emits drop events.
 *
 * Buffer behavior, by context:
 *   - In a loot context (regular map or bubble-owning seasonal): every
 *     bag delta flushes immediately, distributed to session / map / seasonal.
 *   - In town: deltas accumulate in a buffer. The buffer flushes either:
 *       a) the 1500ms timer fires (settled town activity → discarded; baseline
 *          and `new_item` still update, but no tracker gets credited),
 *       b) a zone_transition lands us in a loot context (the buffer's contents
 *          are pre-map spends — flushed with mode 'pre-map' so they go to the
 *          session/seasonal trackers but NOT the map tracker, and are exposed
 *          via `getLastPreMapFlush()` for `m.spent` and the watchlist),
 *       c) a zone_transition lands us still in town (pure town transition,
 *          e.g. portal between town zones — buffer keeps draining into the
 *          'town' bucket on the next timer tick).
 *
 * Timer rule: the 1500ms is a max-wait from the FIRST town event, not a
 * sliding window from the last. This prevents a long sequence of small town
 * changes from indefinitely deferring the flush and leaking into the next map.
 *
 * Bag baselines (`BagState._baseline`) advance on every delta regardless of
 * what we publish — discarding a town buffer never desynchronises future
 * in-map delta calculations.
 */
export class ItemHandler implements EventHandler {
  readonly name    = 'item';
  readonly handles = ['bag_update', 'bag_remove', 'zone_transition'] as const;

  // itemId → net change since last flush
  private _buffer: Map<number, number> = new Map();
  private _timer:  ReturnType<typeof setTimeout> | null = null;
  // Snapshot of the most recent pre-map flush (zone_transition into a loot
  // context with non-empty buffer). Consumed by Engine.getLastMapSpends() and
  // MapMaterialHandler. Cleared on engine stop.
  private _lastPreMapFlush: Map<number, number> = new Map();

  /**
   * Returns the most recent pre-map buffer flush — the deltas that landed
   * in a fresh loot context from a town buffer. The map is read-only by
   * convention; consumers must not mutate it.
   */
  getLastPreMapFlush(): ReadonlyMap<number, number> {
    return this._lastPreMapFlush;
  }

  onStop(_ctx: EngineContext): void {
    this._clearTimer();
    this._buffer.clear();
    this._lastPreMapFlush.clear();
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    if (event.type === 'bag_update') {
      const changes = ctx.bag.processUpdate(event.pageId, event.slotId, event.itemId, event.quantity);
      for (const change of changes) {
        this._buffer.set(change.itemId, (this._buffer.get(change.itemId) ?? 0) + change.change);
      }
      this._scheduleFlush(ctx, emit);
      return;
    }

    if (event.type === 'bag_remove') {
      const changes = ctx.bag.processRemove(event.pageId, event.slotId);
      for (const change of changes) {
        this._buffer.set(change.itemId, (this._buffer.get(change.itemId) ?? 0) + change.change);
      }
      this._scheduleFlush(ctx, emit);
      return;
    }

    if (event.type === 'zone_transition') {
      // Bubble-owning seasonals (Sandlord) and ZoneHandler ran first, so
      // ctx.seasonal / ctx.map / ctx.inMap are already updated. If the buffer
      // holds town-buffered deltas and we just entered a loot context, flush
      // them as pre-map spends.
      if (this._buffer.size === 0) return;
      const mode: PublishMode = ctx.isLootContext() ? 'pre-map' : 'town';
      this._flush(ctx, emit, mode);
    }
  }

  private _scheduleFlush(ctx: EngineContext, emit: EmitFn): void {
    if (ctx.isLootContext()) {
      this._flush(ctx, emit, 'in-map'); // immediate
      return;
    }
    // In town: set the timer once on the first buffered event; subsequent
    // events extend the buffer but do NOT restart the timer. Max wait from
    // first event = BUFFER_MS, regardless of how many events follow.
    if (this._timer === null) {
      this._timer = setTimeout(() => this._flush(ctx, emit, 'town'), BUFFER_MS);
    }
  }

  private _flush(ctx: EngineContext, emit: EmitFn, mode: PublishMode): void {
    this._clearTimer();
    if (this._buffer.size === 0) return;

    if (mode === 'pre-map') {
      // Snapshot the buffer for downstream consumers (m.spent, watchlist).
      this._lastPreMapFlush = new Map(this._buffer);
    }

    publishDrops(ctx, emit, this._buffer, {mode});
    this._buffer.clear();
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
