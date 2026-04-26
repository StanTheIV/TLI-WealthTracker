import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from './types';
import {EngineContext} from './context';
import type {LoadedSessionData} from './context';
import type {ItemFilterEngine} from './item-filter';
import type {FilterRule} from '@/types/itemFilter';
import {Tracker} from './tracker';
import {log} from '@/main/logger';

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
    // Preserve loadedSession across reset — loadSession() is called before start().
    const preserved = this._ctx.loadedSession;
    this._ctx.reset();
    this._ctx.loadedSession = preserved;
    this._ctx.phase = 'initializing';
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

  /**
   * Reset the in-flight session WITHOUT touching bag state, filters, or known
   * items. Drops and elapsed for session/map/seasonal go to zero. Map count
   * resets to 0 (or 1 if currently in a map — that map becomes "map #1" of the
   * new run). The current run is discarded; nothing is auto-saved.
   *
   * Pause/run state is preserved: a paused session stays paused, a running
   * one stays running.
   */
  reset(): void {
    if (this._ctx.phase !== 'tracking') return;

    const now = Date.now();
    const wasPaused = this._ctx.paused;

    // Tear down map/seasonal trackers so the renderer drops their UI state.
    // We deliberately do NOT emit tracker_finished for the session: the
    // renderer treats that as "session is over → flip phase to idle", which
    // would put the panel into the initializing-placeholder state. Instead we
    // overwrite the session in place via the tracker_started below.
    if (this._ctx.seasonal) {
      this._emit({type: 'tracker_finished', tracker: this._ctx.seasonal.snapshot(), timestamp: now});
      this._ctx.seasonal = null;
    }
    if (this._ctx.map) {
      this._emit({type: 'tracker_finished', tracker: this._ctx.map.snapshot(), timestamp: now});
      this._ctx.map = null;
    }
    this._ctx.session = null;

    // Wipe map / session counters but preserve scene + bag + filter.
    this._ctx.mapCount           = 0;
    this._ctx.accumulatedMapTime = 0;
    this._ctx.mapStartTime       = 0;
    this._ctx.activeSessionId    = null;
    this._ctx.activeSessionName  = null;
    this._ctx.loadedSession      = null;

    // Fresh session tracker. Match pause state.
    this._ctx.session = new Tracker('session');
    if (wasPaused) this._ctx.session.pause();
    this._emit({
      type:        'tracker_started',
      tracker:     this._ctx.session.snapshot(),
      timestamp:   now,
      sessionMeta: {mapTime: 0, mapCount: 0},
    });

    // If we're currently in a map, recreate that map's tracker as map #1.
    if (this._ctx.inMap) {
      this._ctx.mapCount    = 1;
      this._ctx.mapStartTime = now;
      this._ctx.map         = new Tracker('map');
      if (wasPaused) this._ctx.map.pause();
      this._emit({type: 'map_started', mapCount: 1, timestamp: now});
      this._emit({type: 'tracker_started', tracker: this._ctx.map.snapshot(), timestamp: now});
    }

    // Mirror current pause state to the renderer so its session_status line
    // matches what we just rebuilt.
    this._emit({
      type:      'session_status',
      status:    wasPaused ? 'paused' : 'running',
      elapsed:   0,
      timestamp: now,
    });

    log.info('engine', `Session reset (inMap=${this._ctx.inMap}, paused=${wasPaused})`);
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
