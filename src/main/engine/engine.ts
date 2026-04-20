import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from './types';
import {EngineContext} from './context';
import type {LoadedSessionData} from './context';
import type {ItemFilterEngine} from './item-filter';
import type {FilterRule} from '@/types/itemFilter';

/**
 * EventRouter — thin routing layer.
 *
 * Owns the EngineContext and a registry of EventHandlers.
 * On each RawEvent, calls all handlers that declared interest in that event type.
 * Contains zero domain logic — all logic lives in handlers.
 */
export class Engine {
  private _ctx  = new EngineContext();
  private _emit: EmitFn;
  // Map from event type → ordered list of handlers
  private _routes = new Map<string, EventHandler[]>();

  constructor(emit: EmitFn) {
    this._emit = emit;
  }

  register(handler: EventHandler): this {
    for (const type of handler.handles) {
      if (!this._routes.has(type)) this._routes.set(type, []);
      this._routes.get(type)!.push(handler);
    }
    return this;
  }

  start(): void {
    this._ctx.reset();
    this._ctx.phase   = 'initializing';
    for (const handlers of this._routes.values()) {
      for (const h of handlers) {
        h.onStart?.(this._ctx, this._emit);
      }
    }
  }

  /**
   * Load a previous session's data so it can be merged after bag initialization.
   * Must be called before engine.start().
   */
  loadSession(data: LoadedSessionData): void {
    this._ctx.loadedSession = data;
  }

  stop(): void {
    // Emit final session snapshot before resetting, including map/session metadata for auto-save
    if (this._ctx.session) {
      this._emit({
        type:        'tracker_finished',
        tracker:     this._ctx.session.snapshot(),
        timestamp:   Date.now(),
        sessionMeta: {
          mapTime:  this._ctx.accumulatedMapTime,
          mapCount: this._ctx.mapCount,
        },
      });
    }

    // Deduplicate — a handler registered for multiple types appears multiple times in _routes
    const seen = new Set<EventHandler>();
    for (const handlers of this._routes.values()) {
      for (const h of handlers) {
        if (!seen.has(h)) {
          seen.add(h);
          h.onStop?.(this._ctx);
        }
      }
    }
    this._ctx.reset();
  }

  pause(): void {
    this._ctx.paused = true;
    this._ctx.session?.pause();
    if (this._ctx.session) {
      this._emit({type: 'session_status', status: 'paused', elapsed: this._ctx.session.elapsed(), timestamp: Date.now()});
    }
  }

  resume(): void {
    this._ctx.paused = false;
    this._ctx.session?.resume();
    if (this._ctx.session) {
      this._emit({type: 'session_status', status: 'running', elapsed: this._ctx.session.elapsed(), timestamp: Date.now()});
    }
  }

  setFilter(filter: ItemFilterEngine): void {
    this._ctx.filter = filter;
  }

  getFilter(): ItemFilterEngine | null {
    return this._ctx.filter;
  }

  updateFilterRules(rules: FilterRule[] | null): void {
    if (rules === null) {
      this._ctx.filter = null;
    } else {
      this._ctx.filter?.setRules(rules);
    }
  }

  setItemType(itemId: string, type: import('@/types/itemType').ItemType): void {
    this._ctx.filter?.setItemType(itemId, type);
  }

  setKnownItems(ids: Iterable<string>): void {
    this._ctx.knownItems = new Set(ids);
  }

  getInventory(): Map<number, number> {
    return this._ctx.bag.getInventory();
  }

  onRawEvent(event: RawEvent): void {
    const handlers = this._routes.get(event.type);
    if (!handlers) return;
    for (const h of handlers) {
      h.handle(event, this._ctx, this._emit);
    }
  }
}
