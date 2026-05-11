import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from './types';
import {EngineContext} from './context';
import type {LoadedSessionData} from './context';
import type {ItemFilterEngine} from './item-filter';
import type {FilterRule} from '@/types/itemFilter';
import {ItemHandler} from './handlers/item';
import {MapMaterialHandler} from './handlers/map-material';
import {OverrealmHandler} from './handlers/overrealm-handler';
import {CarjackHandler} from './handlers/carjack-handler';
import {ClockworkHandler} from './handlers/clockwork-handler';
import {LunariaHandler} from './handlers/lunaria-handler';
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
  // Map from event type → ordered list of handlers (a handler appears in
  // multiple buckets if it registered for multiple event types).
  private _routes = new Map<string, EventHandler[]>();
  // Deduplicated registry — used for cross-cutting iteration that should
  // visit each handler exactly once (onStop).
  private _handlers: EventHandler[] = [];
  private _mapMaterial: MapMaterialHandler | null = null;
  private _item:        ItemHandler        | null = null;
  private _overrealm:   OverrealmHandler   | null = null;
  private _carjack:     CarjackHandler     | null = null;
  private _clockwork:   ClockworkHandler   | null = null;
  private _lunaria:     LunariaHandler     | null = null;

  constructor(emit: EmitFn) {
    this._emit = emit;
  }

  register(handler: EventHandler): this {
    for (const type of handler.handles) {
      if (!this._routes.has(type)) this._routes.set(type, []);
      this._routes.get(type)!.push(handler);
    }
    this._handlers.push(handler);
    if (handler instanceof ItemHandler)        this._item        = handler;
    if (handler instanceof MapMaterialHandler) this._mapMaterial = handler;
    if (handler instanceof OverrealmHandler)   this._overrealm   = handler;
    if (handler instanceof CarjackHandler)     this._carjack     = handler;
    if (handler instanceof ClockworkHandler)   this._clockwork   = handler;
    if (handler instanceof LunariaHandler)     this._lunaria     = handler;
    return this;
  }

  start(): void {
    const preserved = this._ctx.loadedSession;
    this._ctx.reset();
    this._ctx.loadedSession = preserved;
    this._ctx.phase = 'initializing';
    for (const h of this._handlers) h.onStart?.(this._ctx, this._emit);
  }

  loadSession(data: LoadedSessionData): void {
    this._ctx.loadedSession = data;
  }

  stop(): void {
    // Emit final session snapshot before tearing down, including map/session
    // metadata for auto-save. Active map / seasonals are silently dropped —
    // session-level finish is the renderer's signal that the run is over.
    if (this._ctx.registry.session) {
      this._emit({
        type:        'tracker_finished',
        tracker:     this._ctx.registry.session.snapshot(),
        timestamp:   Date.now(),
        sessionMeta: {
          mapTime:  this._ctx.accumulatedMapTime,
          mapCount: this._ctx.mapCount,
        },
      });
    }

    for (const h of this._handlers) h.onStop?.(this._ctx);
    this._ctx.reset();
  }

  /**
   * Reset the in-flight session WITHOUT touching bag state, filters, or known
   * items. Drops and elapsed for session/map/seasonal go to zero. Map count
   * resets to 0 (or 1 if currently in a map — that map becomes "map #1" of the
   * new run). Pause/run state preserved.
   */
  reset(): void {
    if (this._ctx.phase !== 'tracking') return;

    const now = Date.now();
    const wasPaused = this._ctx.paused;

    // Tear down map/seasonal trackers so the renderer drops their UI state.
    // Deliberately do NOT emit tracker_finished for the session — that would
    // flip the renderer's phase to 'idle'. Each seasonal's finish() emits
    // its own tracker_finished; the registry handles map separately below.
    this._ctx.registry.finishAllSeasonals();
    if (this._ctx.registry.map) {
      this._emit({type: 'tracker_finished', tracker: this._ctx.registry.map.snapshot(), timestamp: now});
      this._ctx.registry.map = null;
    }
    this._ctx.registry.invalidateWriter();
    this._ctx.registry.session = null;

    this._ctx.mapCount           = 0;
    this._ctx.accumulatedMapTime = 0;
    this._ctx.mapStartTime       = 0;
    this._ctx.activeSessionId    = null;
    this._ctx.activeSessionName  = null;
    this._ctx.loadedSession      = null;

    const session = this._ctx.registry.startSession();
    if (wasPaused) session.pause();
    this._emit({
      type:        'tracker_started',
      tracker:     session.snapshot(),
      timestamp:   now,
      sessionMeta: {mapTime: 0, mapCount: 0},
    });

    if (this._ctx.inMap) {
      this._ctx.mapCount     = 1;
      this._ctx.mapStartTime = now;
      const map = this._ctx.registry.startMap();
      if (map) {
        if (wasPaused) map.pause();
        this._emit({type: 'map_started', mapCount: 1, timestamp: now});
        this._emit({type: 'tracker_started', tracker: map.snapshot(), timestamp: now});
      }
    }

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
    this._ctx.registry.session?.pause();
    if (this._ctx.registry.session) {
      this._emit({type: 'session_status', status: 'paused', elapsed: this._ctx.registry.session.elapsed(), timestamp: Date.now()});
    }
  }

  resume(): void {
    this._ctx.paused = false;
    this._ctx.registry.session?.resume();
    if (this._ctx.registry.session) {
      this._emit({type: 'session_status', status: 'running', elapsed: this._ctx.registry.session.elapsed(), timestamp: Date.now()});
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

  /** True iff a map tracker is currently active. */
  hasActiveMapTracker(): boolean {
    return this._ctx.registry.map !== null;
  }

  /** Look up a registered handler by its `name` field — primarily a test
   *  affordance. Returns null if unknown. */
  getHandler(name: string): EventHandler | null {
    return this._handlers.find(h => h.name === name) ?? null;
  }

  // --- Map material delegation -------------------------------------------------

  dismissMaterial(itemId: number): void {
    this._mapMaterial?.dismiss(itemId);
  }

  setLowStockThreshold(n: number): void {
    this._mapMaterial?.setThreshold(n);
  }

  // --- Seasonal loot timer durations (ms) ----------------------------------

  setOverrealmLootDurationMs(ms: number): void {
    this._overrealm?.setLootDurationMs(ms);
  }

  setCarjackLootDurationMs(ms: number): void {
    this._carjack?.setLootDurationMs(ms);
  }

  setClockworkLootDurationMs(ms: number): void {
    this._clockwork?.setLootDurationMs(ms);
  }

  setLunariaLootDurationMs(ms: number): void {
    this._lunaria?.setLootDurationMs(ms);
  }

  /**
   * Per-map spend record for the most recently entered map. Sourced from
   * ItemHandler's pre-map buffer flush.
   */
  getLastMapSpends(): Record<string, number> {
    const out: Record<string, number> = {};
    const flush = this._item?.getLastPreMapFlush();
    if (!flush) return out;
    for (const [id, change] of flush) {
      if (change < 0) out[String(id)] = -change;
    }
    return out;
  }

  onRawEvent(event: RawEvent): void {
    const handlers = this._routes.get(event.type);
    if (!handlers) return;
    for (const h of handlers) {
      h.handle(event, this._ctx, this._emit);
    }
  }
}
