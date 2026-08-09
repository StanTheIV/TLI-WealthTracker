import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {publishDrops} from '@/main/engine/drop-publisher';

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
 *          are pre-map spends — flushed as in-map deltas so they fan out to
 *          session/map/seasonal trackers, AND snapshotted into
 *          `_lastPreMapFlush` so the engine can expose them as the per-map
 *          `m.spent` record for the chart's cost line),
 *       c) a zone_transition lands us still in town (handler also flushes,
 *          but with `lootContext: false` — discarded the same way the timer
 *          does).
 *
 * Timer rule: the 1500ms is a max-wait from the FIRST town event, not a
 * sliding window from the last. This prevents a long sequence of small town
 * changes from indefinitely deferring the flush and leaking into the next map.
 *
 * Bag baselines (`BagState._baseline`) advance on every delta regardless of
 * what we publish — discarding a town buffer never desynchronises future
 * in-map delta calculations.
 *
 * Pre-map spend recording: the chart's per-map "cost" line reads
 * `engine.getLastMapSpends()`, which projects `_lastPreMapFlush` (negatives
 * only, magnitudes flipped). The same delta lives in `m.drops` (negative)
 * and `m.spent` (positive magnitude); the chart math is responsible for not
 * double-counting them — see `SessionDetail.tsx`.
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

    // Paused = crediting frozen. bag_update / bag_remove are pure crediting →
    // skip. A zone_transition is structural, but its buffer holds town deltas
    // that must not be credited across a pause-time transition, so discard
    // (not flush) so they can't leak into the next map on resume.
    if (ctx.paused) {
      if (event.type === 'zone_transition') {
        this._clearTimer();
        this._buffer.clear();
      }
      return;
    }

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
      // holds town-buffered deltas, flush them now — into the freshly-created
      // tracker if we're now in a loot context, otherwise discard.
      const recordPreMap = ctx.registry.isLootContext();
      // Nothing buffered means nothing was consumed for THIS run — reset, or the
      // run inherits its predecessor's basket and double-books the materials.
      if (this._buffer.size === 0) {
        if (recordPreMap) this._lastPreMapFlush = new Map();
        return;
      }
      this._flush(ctx, emit, recordPreMap);
    }
  }

  private _scheduleFlush(ctx: EngineContext, emit: EmitFn): void {
    if (ctx.registry.isLootContext()) {
      this._flush(ctx, emit, /*recordPreMap*/ false); // immediate in-map flush
      return;
    }
    // In town: set the timer once on the first buffered event; subsequent
    // events extend the buffer but do NOT restart the timer. Max wait from
    // first event = BUFFER_MS, regardless of how many events follow.
    if (this._timer === null) {
      this._timer = setTimeout(() => this._flush(ctx, emit, /*recordPreMap*/ false), BUFFER_MS);
    }
  }

  /**
   * Flush the buffer.
   * - `recordPreMap`: true only when this flush represents a town buffer
   *   landing in a fresh loot context (zone_transition into a map / bubble).
   *   Snapshots the buffer into `_lastPreMapFlush` so the engine can expose
   *   it as `m.spent`. Immediate in-map flushes (steady-state map looting)
   *   and town-timer flushes (settled activity, discarded) do not record.
   *   The empty-buffer case is handled by the caller, which clears the
   *   snapshot so a run that consumed nothing records nothing.
   */
  private _flush(ctx: EngineContext, emit: EmitFn, recordPreMap: boolean): void {
    this._clearTimer();
    if (this._buffer.size === 0) return;

    if (recordPreMap) {
      this._lastPreMapFlush = new Map(this._buffer);
    }

    publishDrops(ctx, emit, this._buffer, {lootContext: ctx.registry.isLootContext()});
    this._buffer.clear();
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
