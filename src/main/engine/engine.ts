import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn, EngineSink} from './types';
import {EngineContext} from './context';
import type {LoadedSessionData} from './context';
import {openSessionRun} from './session-run';
import type {SessionIdentity} from '@/shared/contracts/engine';
import {ItemFilterEngine} from './item-filter';
import type {FilterRule} from '@/shared/item-filter';
import type {ItemType} from '@/shared/items';
import {MapMaterialHandler} from './handlers/map-material';
import {OverrealmHandler} from './handlers/overrealm-handler';
import {CarjackHandler} from './handlers/carjack-handler';
import {ClockworkHandler} from './handlers/clockwork-handler';
import {LunariaHandler} from './handlers/lunaria-handler';
import {SandlordMapHandler} from './handlers/sandlord-map-handler';
import {HuntingHandler} from './handlers/hunting-handler';
import {AfterlightHandler} from './handlers/afterlight-handler';
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
  private readonly _sink: EngineSink;
  /** What handlers, trackers and the registry emit through. Stamps each
   *  `unit_finished` with its checkpoint — the session state as of the unit —
   *  which only the context holds (the registry has no counters). */
  private readonly _emit: EmitFn = (event) => {
    if (event.type !== 'unit_finished') {
      this._sink(event);
      return;
    }
    const session = this._ctx.registry.session;
    if (!session) throw new Error('unit_finished without a session'); // the registry emits units only while one exists
    this._sink({
      ...event,
      checkpoint: {
        session:  session.snapshot(),
        mapTime:  this._ctx.accumulatedMapTime,
        mapCount: this._ctx.mapCount,
      },
    });
  };
  // Map from event type → ordered list of handlers (a handler appears in
  // multiple buckets if it registered for multiple event types).
  private _routes = new Map<string, EventHandler[]>();
  // Deduplicated registry — used for cross-cutting iteration that should
  // visit each handler exactly once (onStop).
  private _handlers: EventHandler[] = [];
  private _mapMaterial: MapMaterialHandler | null = null;
  private _overrealm:   OverrealmHandler   | null = null;
  private _carjack:     CarjackHandler     | null = null;
  private _clockwork:   ClockworkHandler   | null = null;
  private _lunaria:     LunariaHandler     | null = null;
  private _sandlordMap: SandlordMapHandler | null = null;
  private _hunting:     HuntingHandler     | null = null;
  private _afterlight:  AfterlightHandler  | null = null;

  constructor(sink: EngineSink) {
    this._sink = sink;
  }

  register(handler: EventHandler): this {
    for (const type of handler.handles) {
      if (!this._routes.has(type)) this._routes.set(type, []);
      this._routes.get(type)!.push(handler);
    }
    this._handlers.push(handler);
    if (handler instanceof MapMaterialHandler) this._mapMaterial = handler;
    if (handler instanceof OverrealmHandler)   this._overrealm   = handler;
    if (handler instanceof CarjackHandler)     this._carjack     = handler;
    if (handler instanceof ClockworkHandler)   this._clockwork   = handler;
    if (handler instanceof LunariaHandler)     this._lunaria     = handler;
    if (handler instanceof SandlordMapHandler) this._sandlordMap = handler;
    if (handler instanceof HuntingHandler)     this._hunting     = handler;
    if (handler instanceof AfterlightHandler)  this._afterlight  = handler;
    return this;
  }

  /** Start a run as `identity`. The session itself opens once the bag
   *  baseline lands (BagInitHandler); a `loadSession` call before this makes
   *  it a continue. */
  start(identity: SessionIdentity): void {
    const preserved = this._ctx.loadedSession;
    this._ctx.reset();
    this._ctx.loadedSession     = preserved;
    this._ctx.activeSessionId   = identity.sessionId;
    this._ctx.activeSessionName = identity.name;
    this._ctx.phase = 'initializing';
    for (const h of this._handlers) h.onStart?.(this._ctx, this._emit);
  }

  /** Continue: the saved run data the next `start` seeds the session with. */
  loadSession(data: LoadedSessionData): void {
    this._ctx.loadedSession = data;
  }

  stop(): void {
    // Emit final session snapshot before tearing down, including map/session
    // metadata for auto-save. Active map / seasonals are silently dropped —
    // session-level finish is the renderer's signal that the run is over. The
    // live map's already-finished children go out first as standalone units,
    // so they are saved with the session.
    this._ctx.registry.promoteMapChildren(this._emit);
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
   * Replace the in-flight session with a fresh one as `identity`, WITHOUT
   * touching bag state, filters, or known items. Drops and elapsed for
   * session/map/seasonal go to zero. Map count resets to 0 (or 1 if currently
   * in a map — that map becomes "map #1" of the new run) and keeps that map's
   * entry cost. Pause/run state preserved. A no-op unless tracking.
   */
  reset(identity: SessionIdentity): void {
    if (this._ctx.phase !== 'tracking') return;

    const now = Date.now();
    const wasPaused = this._ctx.paused;

    // Fresh trackers below — clear pause bookkeeping tied to the torn-down ones
    // (finishing a seasonal also drops it from the registry's session-frozen set).
    this._ctx.mapPausedForInterludeAt = null;

    // The materials were consumed to open the map the player is still in, so
    // its rebuilt tracker (and the new session) keep the entry cost.
    const carriedCost: ReadonlyMap<number, number> = new Map(this._ctx.registry.map?.entryCost ?? []);
    // Tear down map/seasonal trackers so the renderer drops their UI state,
    // emitting no unit (the reset run is never saved). Deliberately do NOT
    // emit tracker_finished for the session — that would flip the renderer's
    // phase to 'idle'.
    this._ctx.registry.discardForReset(this._emit, now);
    this._ctx.registry.session = null;

    this._ctx.activeSessionId   = identity.sessionId;
    this._ctx.activeSessionName = identity.name;
    this._ctx.loadedSession     = null;
    openSessionRun(this._ctx, this._emit, now, carriedCost);

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
   * The registry records exactly which seasonals the session pause froze so
   * resume() only unfreezes those: a seasonal already self-paused (Lunaria
   * between strums, Arcana backed-out minigame) or a map paused for a seasonal
   * interlude must NOT be resumed by a session resume — whoever paused a thing
   * resumes it. A tracker that starts while paused is frozen at start (Zone for
   * a map, Sandlord for a hub run) and resumes here the same way.
   *
   * A tracking-only command: outside 'tracking' there is no session to freeze,
   * so the pause is dropped, not deferred — latching ctx.paused during
   * 'initializing' would start a running session whose every drop is ignored.
   * That makes paused ⇒ tracking, which resume() relies on.
   */
  pause(): void {
    if (this._ctx.phase !== 'tracking' || this._ctx.paused) return;
    const now = Date.now();
    this._ctx.paused = true;

    this._ctx.registry.session?.pause();

    // Pause the map only if WE find it running (it may already be paused for a
    // seasonal interlude — leave that alone). pauseMap emits tracker_update.
    if (this._ctx.registry.map?.active) {
      this._ctx.registry.pauseMap(this._emit);
    }

    // Pause every currently-active seasonal (self-paused ones are skipped) and
    // freeze every in-flight loot window — a pause must not eat the player's
    // collection time.
    this._ctx.registry.freezeAllForSessionPause();

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
    // resume only the seasonals the session pause froze.
    this._ctx.registry.thawSessionPause();

    if (this._ctx.registry.session) {
      this._emit({type: 'session_status', status: 'running', elapsed: this._ctx.registry.session.elapsed(), timestamp: now});
    }
  }

  /** The one way to change filtering: null clears it, a rule list builds the
   *  filter on first use and replaces its rules after that. */
  setFilterRules(rules: FilterRule[] | null): void {
    if (rules === null)        this._ctx.filter = null;
    else if (this._ctx.filter) this._ctx.filter.setRules(rules);
    else                       this._ctx.filter = new ItemFilterEngine(rules, this._ctx.itemTypes);
  }

  /** Replace the item-type map wholesale (engine start). */
  setItemTypes(types: Iterable<readonly [string, ItemType]>): void {
    this._ctx.itemTypes.clear();
    for (const [id, type] of types) this._ctx.itemTypes.set(id, type);
  }

  /** A single item's type became known or changed mid-session. */
  setItemType(itemId: string, type: ItemType): void {
    this._ctx.itemTypes.set(itemId, type);
  }

  setKnownItems(ids: Iterable<string>): void {
    this._ctx.knownItems = new Set(ids);
  }

  getInventory(): Map<number, number> {
    return this._ctx.bag.getInventory();
  }

  /** Read-only copies of the bag's slot layout and per-item totals, so the log
   *  replayer can assert `totals == Σ slots` without reaching into `_ctx`. */
  getBagDiagnostics(): {initialized: boolean; slots: Map<string, {itemId: number; quantity: number}>; totals: Map<number, number>} {
    const bag = this._ctx.bag;
    return {initialized: bag.initialized, slots: bag.getSlots(), totals: bag.getInventory()};
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

  setAfterlightLootDurationMs(ms: number): void {
    this._afterlight?.setLootDurationMs(ms);
  }

  onRawEvent(event: RawEvent): void {
    const handlers = this._routes.get(event.type);
    if (!handlers) return;
    this._ctx.bagDeltas = [];
    for (const h of handlers) {
      h.handle(event, this._ctx, this._emit);
    }
  }
}
