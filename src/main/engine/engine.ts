import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn, EngineSink} from './types';
import {EngineContext} from './context';
import type {LoadedSessionData} from './context';
import {openSessionRun} from './session-run';
import type {EngineEvent, SessionIdentity} from '@/shared/contracts/engine';
import {ItemFilterEngine} from './item-filter';
import type {FilterRule} from '@/shared/item-filter';
import type {ItemType} from '@/shared/items';
import type {Settings} from '@/shared/settings';
import {MapMaterialHandler} from './handlers/map-material';
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
  /** The one handler the Engine addresses directly: a dismiss is a user
   *  action on its private watch state, not a setting. */
  private _mapMaterial: MapMaterialHandler | null = null;
  /** Every registered handler's `replay`, in registration order. */
  private readonly _replayHooks: Array<(ctx: EngineContext) => EngineEvent[]> = [];

  constructor(sink: EngineSink) {
    this._sink = sink;
  }

  register(handler: EventHandler): this {
    for (const type of handler.handles) {
      if (!this._routes.has(type)) this._routes.set(type, []);
      this._routes.get(type)!.push(handler);
    }
    this._handlers.push(handler);
    const onSessionOpen = handler.onSessionOpen?.bind(handler);
    if (onSessionOpen) this._ctx.sessionOpenHooks.push(onSessionOpen);
    const replay = handler.replay?.bind(handler);
    if (replay) this._replayHooks.push(replay);
    if (handler instanceof MapMaterialHandler) this._mapMaterial = handler;
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

  /**
   * End the run. The live map's already-finished children go out first as
   * standalone units, then the final session snapshot (with the map/session
   * metadata for the final write); active map / seasonals are silently dropped.
   * `engine_stopped` comes last whenever a run existed — initializing included,
   * where no session has opened yet. A stop with no run emits nothing.
   */
  stop(): void {
    const hadRun = this._ctx.phase !== 'idle';
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
    if (hadRun) this._emit({type: 'engine_stopped', timestamp: Date.now()});
  }

  /**
   * Replace the in-flight session with a fresh one as `identity`, WITHOUT
   * touching bag state, filters, or known items. Drops and elapsed for
   * session/map/seasonal go to zero. Map count resets to 0 (or 1 if currently
   * in a map — that map becomes "map #1" of the new run) and keeps that map's
   * entry cost. Pause/run state preserved. An interlude (or Dream) still in
   * progress starts a fresh run and re-freezes that map (onSessionOpen, run by
   * openSessionRun). A no-op unless tracking.
   */
  reset(identity: SessionIdentity): void {
    if (this._ctx.phase !== 'tracking') return;

    const now = Date.now();
    const wasPaused = this._ctx.paused;

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
    // for an ONGOING seasonal interlude (ctx.mapPausedForInterludeAt !== null —
    // a claim on THIS map: the registry drops it with the map that ended) —
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

  /**
   * The run's UI-visible state as ordinary EngineEvents: fed to a fresh
   * renderer store they rebuild what the live event stream built. Pure — emits,
   * records and logs nothing; snapshots are taken now.
   *
   * Idle → []. Otherwise `init_started`, then once the session is open
   * `init_complete` and the session `tracker_started` (identity, counters,
   * `active` false while paused); the handlers' own UI state (the current
   * zone, low-stock warnings); the map; every live seasonal in start order,
   * `owner` stamped; one `loot_window_started` per running window — a window
   * frozen by the pause has no deadline and is not shown. Never a drop, a
   * persistence or a lifecycle-end event: history is not state.
   */
  getState(): EngineEvent[] {
    const ctx = this._ctx;
    if (ctx.phase === 'idle') return [];
    const now = Date.now();
    const events: EngineEvent[] = [{type: 'init_started'}];

    // Pre-init trackers are never announced, so only an open session's count.
    const session = ctx.phase === 'tracking' ? ctx.registry.session : null;
    if (session) {
      const {activeSessionId: sessionId, activeSessionName: name} = ctx;
      if (sessionId === null || name === null) throw new Error('getState: an open session without identity');
      events.push({type: 'init_complete', itemCount: ctx.bag.itemCount});
      events.push({
        type:        'tracker_started',
        tracker:     session.snapshot(),
        timestamp:   now,
        sessionMeta: {sessionId, name, continued: ctx.sessionContinued, mapTime: ctx.accumulatedMapTime, mapCount: ctx.mapCount},
      });
    }

    for (const replay of this._replayHooks) events.push(...replay(ctx));

    if (!session) return events;
    const map = ctx.registry.map;
    if (map) events.push({type: 'tracker_started', tracker: map.snapshot(), timestamp: now});
    const seasonals = ctx.registry.replaySeasonals();
    for (const {snapshot} of seasonals) events.push({type: 'tracker_started', tracker: snapshot, timestamp: now});
    for (const {tracker} of seasonals) {
      const deadline = tracker.lootDeadline;
      if (deadline !== null) events.push({type: 'loot_window_started', seasonalType: tracker.seasonalType, deadline, timestamp: now});
    }
    return events;
  }

  /** True once the session is open (bag baseline landed) until stop — paused included. */
  isTracking(): boolean {
    return this._ctx.phase === 'tracking';
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

  /** Hand the parsed settings to every handler; each reads its own fields
   *  (the windowed mechanics their `lootWindowMs` entry, MapMaterial the
   *  low-stock threshold). */
  configure(settings: Settings): void {
    for (const h of this._handlers) h.configure?.(settings);
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
