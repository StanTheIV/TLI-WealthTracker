import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {Tracker} from '@/main/engine/tracker';
import {log} from '@/main/logger';

const DEBOUNCE_MS = 500;

/**
 * BagInitHandler — manages the bag initialisation phase.
 *
 * Collects bag_init events, debounces 500ms of silence, then freezes
 * the BagState baselines and transitions the engine to 'tracking'.
 */
export class BagInitHandler implements EventHandler {
  readonly name    = 'bag-init';
  readonly handles = ['bag_init'] as const;

  private _timer: ReturnType<typeof setTimeout> | null = null;

  onStart(ctx: EngineContext, emit: EmitFn): void {
    this._clear();
    emit({type: 'init_started'});
  }

  onStop(_ctx: EngineContext): void {
    this._clear();
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'bag_init') return;
    if (ctx.phase !== 'initializing') return;

    ctx.bag.processInit(event.pageId, event.slotId, event.itemId, event.quantity);

    this._clear();
    this._timer = setTimeout(() => {
      ctx.bag.finishInit();
      ctx.phase = 'tracking';
      ctx.session = new Tracker('session');

      // Merge loaded session data for continuation runs
      if (ctx.loadedSession) {
        const loaded = ctx.loadedSession;
        ctx.activeSessionId    = loaded.id;
        ctx.activeSessionName  = loaded.name;
        ctx.mapCount           = loaded.mapCount;
        ctx.accumulatedMapTime = loaded.mapTime * 1000; // seconds → ms

        if (ctx.session) {
          for (const [idStr, qty] of Object.entries(loaded.drops)) {
            ctx.session.addDrop(Number(idStr), qty);
          }
          ctx.session.addTimeOffset(loaded.totalTime * 1000); // seconds → ms
        }
        ctx.loadedSession = null;
      }

      log.info('engine', `Phase: initializing -> tracking (${ctx.bag.itemCount} items)`);
      emit({type: 'init_complete', itemCount: ctx.bag.itemCount});
      if (ctx.session) {
        emit({type: 'tracker_started', tracker: ctx.session.snapshot(), timestamp: Date.now()});
      }
    }, DEBOUNCE_MS);
  }

  private _clear(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
