import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import type {SlotSnapshotEntry} from '@/main/engine/bag-state';
import {publishDrops} from '@/main/engine/drop-publisher';
import {log} from '@/main/logger';

const INIT_DEBOUNCE_MS   = 500;
const RESORT_DEBOUNCE_MS = 300;

/**
 * BagInitHandler — turns full bag dumps (`bag_init` bursts) into BagState
 * snapshots, in both engine phases.
 *
 * The game writes a dump — one InitBagData line per occupied slot, absolute
 * stack sizes — after an Arrange click and on login / character load. Every
 * dump is preceded by an `ItemChange@ Reset PageId=` line (`bag_snapshot_start`).
 * A dump is collected whole and applied as one unit:
 *
 *   initializing — the first dump becomes the baseline; the engine moves to
 *                  'tracking' and the session starts.
 *   tracking     — the dump replaces the slot layout (`processResort`); any
 *                  aggregate change goes through the drop pipeline. A pure
 *                  reshuffle produces no drops.
 *
 * A dump ends at the next `bag_snapshot_start`, or after a quiet debounce when
 * none follows. The marker matters: double-clicking Arrange writes two
 * complete dumps ~220 ms apart, inside one debounce window, and they must be
 * applied one after the other — never as one merged buffer.
 */
export class BagInitHandler implements EventHandler {
  readonly name    = 'bag-init';
  readonly handles = ['bag_init', 'bag_snapshot_start'] as const;

  private _dump:  SlotSnapshotEntry[] = [];
  private _timer: ReturnType<typeof setTimeout> | null = null;

  onStart(_ctx: EngineContext, emit: EmitFn): void {
    this._discardDump();
    emit({type: 'init_started'});
  }

  onStop(_ctx: EngineContext): void {
    this._discardDump();
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase === 'idle') return;

    if (event.type === 'bag_snapshot_start') {
      this._applyDump(ctx, emit);
      return;
    }
    if (event.type !== 'bag_init') return;

    this._dump.push({pageId: event.pageId, slotId: event.slotId, itemId: event.itemId, quantity: event.quantity});
    this._clearTimer();
    const debounce = ctx.phase === 'initializing' ? INIT_DEBOUNCE_MS : RESORT_DEBOUNCE_MS;
    this._timer = setTimeout(() => this._applyDump(ctx, emit), debounce);
  }

  /** Close the dump in progress and apply it. A boundary with nothing
   *  collected (a Reset line no dump followed) is a no-op. */
  private _applyDump(ctx: EngineContext, emit: EmitFn): void {
    this._clearTimer();
    const entries = this._dump;
    this._dump = [];
    if (entries.length === 0) return;

    if (ctx.phase === 'initializing') this._initialize(entries, ctx, emit);
    else if (ctx.phase === 'tracking') this._resort(entries, ctx, emit);
  }

  // ---------------------------------------------------------------------
  // Initializing — the first dump is the baseline
  // ---------------------------------------------------------------------

  private _initialize(entries: SlotSnapshotEntry[], ctx: EngineContext, emit: EmitFn): void {
    ctx.bag.init(entries);
    ctx.phase   = 'tracking';
    const session = ctx.registry.startSession();

    const now = Date.now();
    for (const itemId of ctx.bag.getInventory().keys()) {
      const idStr = String(itemId);
      if (!ctx.knownItems.has(idStr)) {
        ctx.knownItems.add(idStr);
        emit({type: 'new_item', itemId, timestamp: now});
      }
    }

    if (ctx.loadedSession) {
      const loaded = ctx.loadedSession;
      ctx.activeSessionId    = loaded.id;
      ctx.activeSessionName  = loaded.name;
      ctx.mapCount           = loaded.mapCount;
      ctx.accumulatedMapTime = loaded.mapTime * 1000;

      for (const [idStr, qty] of Object.entries(loaded.drops)) {
        session.addDrop(Number(idStr), qty);
      }
      session.addTimeOffset(loaded.totalTime * 1000);
      ctx.loadedSession = null;
    }

    log.info('engine', `Phase: initializing -> tracking (${ctx.bag.itemCount} items)`);
    emit({type: 'init_complete', itemCount: ctx.bag.itemCount});
    emit({
      type:        'tracker_started',
      tracker:     session.snapshot(),
      timestamp:   Date.now(),
      sessionMeta: {mapTime: ctx.accumulatedMapTime, mapCount: ctx.mapCount},
    });
  }

  // ---------------------------------------------------------------------
  // Tracking — a later dump replaces the layout
  // ---------------------------------------------------------------------

  private _resort(entries: SlotSnapshotEntry[], ctx: EngineContext, emit: EmitFn): void {
    const changes = ctx.bag.processResort(entries);
    log.debug('engine', `Resort applied: ${entries.length} slots, ${changes.length} aggregate deltas`);

    // Structural vs crediting: processResort above (bag-state sync) always runs
    // so absolute quantities stay correct — but the resulting deltas are
    // crediting, so while paused we stop here and publish nothing.
    if (ctx.paused) return;

    publishDrops(ctx, emit, changes.map(c => [c.itemId, c.change] as const), {lootContext: ctx.registry.isLootContext()});
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private _discardDump(): void {
    this._clearTimer();
    this._dump = [];
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
