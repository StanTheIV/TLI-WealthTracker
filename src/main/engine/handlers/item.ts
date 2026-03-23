import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const BUFFER_MS = 1500;

/**
 * ItemHandler — tracks inventory changes and emits drop events.
 *
 * Buffers multiple bag changes within a time window to debounce rapid
 * successive slot updates for the same item. Flushes immediately in a
 * map; delays flush in town (player may be sorting/picking up items).
 *
 * Also handles zone_transition to flush the buffer when leaving a map.
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
      // ZoneHandler runs first (registered before ItemHandler) and has already
      // updated ctx.inMap. If we just left a map, flush immediately.
      if (!ctx.inMap) this._flush(ctx, emit);
    }
  }

  private _scheduleFlush(ctx: EngineContext, emit: EmitFn): void {
    if (ctx.inMap) {
      this._flush(ctx, emit); // immediate in map
    } else {
      this._clearTimer();
      this._timer = setTimeout(() => this._flush(ctx, emit), BUFFER_MS);
    }
  }

  private _flush(ctx: EngineContext, emit: EmitFn): void {
    this._clearTimer();
    if (this._buffer.size === 0) return;

    const now = Date.now();
    for (const [itemId, change] of this._buffer) {
      if (change === 0) continue;
      ctx.distributeDrop(itemId, change);
      emit({type: 'drop', itemId, change, timestamp: now});
    }
    this._buffer.clear();

    // Push updated snapshots so the frontend sees live drop totals
    if (ctx.map) emit({type: 'tracker_update', tracker: ctx.map.snapshot(), timestamp: now});
    if (ctx.session) emit({type: 'tracker_update', tracker: ctx.session.snapshot(), timestamp: now});
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
