import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import type {SlotSnapshotEntry} from '@/main/engine/bag-state';
import {Tracker} from '@/main/engine/tracker';
import {publishDrops} from '@/main/engine/drop-publisher';
import {log} from '@/main/logger';

const INIT_DEBOUNCE_MS   = 500;
const RESORT_DEBOUNCE_MS = 300;

/**
 * BagInitHandler — handles `bag_init` events in both engine phases.
 *
 * Phase 'initializing':
 *   Collects the initial bag dump, debounces 500ms of silence, then freezes
 *   BagState baselines and transitions the engine to 'tracking'.
 *
 * Phase 'tracking':
 *   The game re-emits InitBagData in bulk when the player resorts their
 *   inventory (or when the server pushes a fresh layout after stash/trade
 *   interactions). We buffer the burst, then apply it as a full slot snapshot
 *   — `BagState.processResort` returns any aggregate-delta changes, which are
 *   fed into the normal drop pipeline. Pure slot reshuffles produce no drops.
 */
export class BagInitHandler implements EventHandler {
  readonly name    = 'bag-init';
  readonly handles = ['bag_init'] as const;

  private _initTimer:   ReturnType<typeof setTimeout> | null = null;
  private _resortTimer: ReturnType<typeof setTimeout> | null = null;
  private _resortBuffer: SlotSnapshotEntry[] = [];

  onStart(_ctx: EngineContext, emit: EmitFn): void {
    this._clearInit();
    this._clearResort();
    emit({type: 'init_started'});
  }

  onStop(_ctx: EngineContext): void {
    this._clearInit();
    this._clearResort();
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'bag_init') return;

    if (ctx.phase === 'initializing') {
      this._handleInit(event, ctx, emit);
      return;
    }

    if (ctx.phase === 'tracking') {
      this._handleResort(event, ctx, emit);
      return;
    }
  }

  // ---------------------------------------------------------------------
  // Initializing phase
  // ---------------------------------------------------------------------

  private _handleInit(
    event: RawEvent & {type: 'bag_init'},
    ctx:   EngineContext,
    emit:  EmitFn,
  ): void {
    ctx.bag.processInit(event.pageId, event.slotId, event.itemId, event.quantity);

    this._clearInit();
    this._initTimer = setTimeout(() => this._finalizeInit(ctx, emit), INIT_DEBOUNCE_MS);
  }

  private _finalizeInit(ctx: EngineContext, emit: EmitFn): void {
    ctx.bag.finishInit();
    ctx.phase   = 'tracking';
    ctx.session = new Tracker('session');

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

      if (ctx.session) {
        for (const [idStr, qty] of Object.entries(loaded.drops)) {
          ctx.session.addDrop(Number(idStr), qty);
        }
        ctx.session.addTimeOffset(loaded.totalTime * 1000);
      }
      ctx.loadedSession = null;
    }

    log.info('engine', `Phase: initializing -> tracking (${ctx.bag.itemCount} items)`);
    emit({type: 'init_complete', itemCount: ctx.bag.itemCount});
    if (ctx.session) {
      emit({
        type:        'tracker_started',
        tracker:     ctx.session.snapshot(),
        timestamp:   Date.now(),
        sessionMeta: {mapTime: ctx.accumulatedMapTime, mapCount: ctx.mapCount},
      });
    }
  }

  // ---------------------------------------------------------------------
  // Tracking phase — resort burst
  // ---------------------------------------------------------------------

  private _handleResort(
    event: RawEvent & {type: 'bag_init'},
    ctx:   EngineContext,
    emit:  EmitFn,
  ): void {
    this._resortBuffer.push({
      pageId:   event.pageId,
      slotId:   event.slotId,
      itemId:   event.itemId,
      quantity: event.quantity,
    });

    this._clearResort();
    this._resortTimer = setTimeout(() => this._finalizeResort(ctx, emit), RESORT_DEBOUNCE_MS);
  }

  private _finalizeResort(ctx: EngineContext, emit: EmitFn): void {
    const entries = this._resortBuffer;
    this._resortBuffer = [];
    this._resortTimer  = null;

    if (entries.length === 0) return;

    const changes = ctx.bag.processResort(entries);
    log.debug('engine', `Resort applied: ${entries.length} slots, ${changes.length} aggregate deltas`);

    // When paused, keep bag state in sync but do not credit/debit trackers.
    if (ctx.paused) return;

    publishDrops(ctx, emit, changes.map(c => [c.itemId, c.change] as const));
  }

  // ---------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------

  private _clearInit(): void {
    if (this._initTimer !== null) {
      clearTimeout(this._initTimer);
      this._initTimer = null;
    }
  }

  private _clearResort(): void {
    if (this._resortTimer !== null) {
      clearTimeout(this._resortTimer);
      this._resortTimer = null;
    }
  }
}
