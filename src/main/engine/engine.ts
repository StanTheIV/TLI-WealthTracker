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
import {SandlordMapHandler} from './handlers/sandlord-map-handler';
import {HuntingHandler} from './handlers/hunting-handler';
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
  private _sandlordMap: SandlordMapHandler | null = null;
  private _hunting:     HuntingHandler     | null = null;

  // Seasonals paused BY the session pause (not those already self-paused for
  // their own reason — Lunaria between strums, Arcana backed-out minigame).
  // Only these are resumed on session resume; a self-paused seasonal stays
  // paused. Maps need no equivalent set — the sole "stay paused" reason is an
  // ongoing seasonal interlude, captured by ctx.mapPausedForInterludeAt.
  private _pausedSeasonals = new Set<import('./tracker').SeasonalType>();

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
    if (handler instanceof SandlordMapHandler) this._sandlordMap = handler;
    if (handler instanceof HuntingHandler)     this._hunting     = handler;
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
    this._pausedSeasonals.clear();
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

    // Fresh trackers below — clear pause bookkeeping tied to the torn-down ones.
    this._pausedSeasonals.clear();
    this._ctx.mapPausedForInterludeAt = null;

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

  /**
   * Pause the whole run. Freezes ALL live trackers — session, map, and every
   * active seasonal — plus every in-flight loot window (remaining time kept).
   * Records exactly which trackers WE paused so resume() only unfreezes those:
   * a seasonal already self-paused (Lunaria between strums, Arcana backed-out
   * minigame) or a map paused for a seasonal interlude must NOT be resumed by
   * a session resume — whoever paused a thing resumes it.
   */
  pause(): void {
    if (this._ctx.paused) return;
    const now = Date.now();
    this._ctx.paused = true;

    this._ctx.registry.session?.pause();

    // Pause the map only if WE find it running (it may already be paused for a
    // seasonal interlude — leave that alone). pauseMap emits tracker_update.
    if (this._ctx.registry.map?.active) {
      this._ctx.registry.pauseMap(this._emit);
    }

    // Pause every currently-active seasonal; remember which so resume() only
    // resumes these. Self-paused seasonals are skipped (active === false).
    // Freeze every in-flight loot window regardless — a pause must not eat
    // the player's collection time.
    this._pausedSeasonals.clear();
    for (const t of this._ctx.registry.seasonals()) {
      if (t.active) {
        t.pauseTracker();
        this._pausedSeasonals.add(t.seasonalType);
      }
      t.freezeLootTimer();
    }

    if (this._ctx.registry.session) {
      this._emit({type: 'session_status', status: 'paused', elapsed: this._ctx.registry.session.elapsed(), timestamp: now});
    }
  }

  /**
   * Resume the run. Unfreezes the map (unless it's paused for an ongoing
   * seasonal interlude) and only the seasonals pause() itself froze — a
   * self-paused seasonal stays paused. Map-time accounting needs no correction:
   * the map tracker's own elapsed() is the authority and already excludes
   * every paused span.
   */
  resume(): void {
    if (!this._ctx.paused) return;
    const now = Date.now();

    this._ctx.paused = false;

    this._ctx.registry.session?.resume();

    // Map resume policy. A map is left paused across resume ONLY if it's paused
    // for an ONGOING seasonal interlude (ctx.mapPausedForInterludeAt !== null) —
    // the interlude owns that pause and resolves it itself. Any other paused map
    // (paused by us at pause() time, started during the pause, or handed over by
    // an interlude that ENDED during the pause) is resumed here.
    //
    // Map-time accounting no longer depends on mapStartTime shifting — ZoneHandler
    // reads the map tracker's own elapsed() at town entry, which already excludes
    // every paused span. We only need to unfreeze the tracker so it accrues again.
    if (this._ctx.inMap && this._ctx.registry.map && !this._ctx.registry.map.active
        && this._ctx.mapPausedForInterludeAt === null) {
      this._ctx.registry.resumeMap(this._emit);
    }

    // Unfreeze every frozen loot window (remaining time continues), then
    // resume only the seasonals we paused. Frozen windows can't expire during
    // a pause, so a self-paused seasonal at pause time is still self-paused
    // here and correctly stays out of _pausedSeasonals.
    for (const t of this._ctx.registry.seasonals()) {
      t.unfreezeLootTimer();
    }
    for (const type of this._pausedSeasonals) {
      // Mechanical resume — restores the pre-pause state without bumping the
      // seasonal in the activation (ownership) order.
      this._ctx.registry.seasonal(type)?.resumeTracker({reactivate: false});
    }
    this._pausedSeasonals.clear();

    if (this._ctx.registry.session) {
      this._emit({type: 'session_status', status: 'running', elapsed: this._ctx.registry.session.elapsed(), timestamp: now});
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

  /** True iff any seasonal tracker is currently live. */
  hasActiveSeasonals(): boolean {
    return this._ctx.registry.seasonalsSize() > 0;
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

  /** In-map Sandlord wave-activity window (not a loot window — see the handler). */
  setSandlordWaveDurationMs(ms: number): void {
    this._sandlordMap?.setWaveDurationMs(ms);
  }

  setHuntingLootDurationMs(ms: number): void {
    this._hunting?.setLootDurationMs(ms);
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
