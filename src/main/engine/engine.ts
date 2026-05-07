import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from './types';
import {EngineContext} from './context';
import type {LoadedSessionData} from './context';
import type {ItemFilterEngine} from './item-filter';
import type {FilterRule} from '@/types/itemFilter';
import {Tracker} from './tracker';
import {ItemHandler} from './handlers/item';
import {MapMaterialHandler} from './handlers/map-material';
import {OverrealmHandler} from './handlers/overrealm-handler';
import {CarjackHandler} from './handlers/carjack-handler';
import {ClockworkHandler} from './handlers/clockwork-handler';
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
  // Typed reference to the map-material handler so the IPC layer can mutate
  // its state through Engine methods rather than reaching across the boundary.
  private _mapMaterial: MapMaterialHandler | null = null;
  // Typed reference to the item handler for derived queries (pre-map spends).
  private _item:        ItemHandler        | null = null;
  // Typed references to seasonal handlers with configurable loot windows.
  private _overrealm:   OverrealmHandler   | null = null;
  private _carjack:     CarjackHandler     | null = null;
  private _clockwork:   ClockworkHandler   | null = null;

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
    return this;
  }

  start(): void {
    // Preserve loadedSession across reset — loadSession() is called before start().
    const preserved = this._ctx.loadedSession;
    this._ctx.reset();
    this._ctx.loadedSession = preserved;
    this._ctx.phase = 'initializing';
    for (const h of this._handlers) h.onStart?.(this._ctx, this._emit);
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

    for (const h of this._handlers) h.onStop?.(this._ctx);
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

  /** True iff a map tracker is currently active. The IPC layer checks this
   *  when a seasonal tracker finishes to tell whether the seasonal was running
   *  inside a map (Vorex / Dream / etc.) or standalone (Sandlord). */
  hasActiveMapTracker(): boolean {
    return this._ctx.map !== null;
  }

  /** Look up a registered handler by its `name` field — primarily a test
   *  affordance for asserting handler-local state. Returns null if unknown. */
  getHandler(name: string): EventHandler | null {
    return this._handlers.find(h => h.name === name) ?? null;
  }

  // --- Map material delegation -------------------------------------------------
  // Thin pass-throughs to the registered MapMaterialHandler so the IPC layer
  // never reaches into a handler instance directly.

  dismissMaterial(itemId: number): void {
    this._mapMaterial?.dismiss(itemId);
  }

  setLowStockThreshold(n: number): void {
    this._mapMaterial?.setThreshold(n);
  }

  // --- Seasonal loot timer durations (ms) ----------------------------------
  // Pass-throughs so the IPC layer never reaches into a handler instance.

  setOverrealmLootDurationMs(ms: number): void {
    this._overrealm?.setLootDurationMs(ms);
  }

  setCarjackLootDurationMs(ms: number): void {
    this._carjack?.setLootDurationMs(ms);
  }

  setClockworkLootDurationMs(ms: number): void {
    this._clockwork?.setLootDurationMs(ms);
  }

  /**
   * Per-map spend record for the most recently entered map: { itemId →
   * positive quantity consumed }. Sourced from ItemHandler's pre-map buffer
   * flush — i.e. the bag deltas that landed in the freshly-created map
   * tracker from a town buffer. Only negative entries (actual spends) are
   * exported; positive entries (e.g. last-second vendor purchase) are
   * filtered out. Returns `{}` when there's nothing to attribute.
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
