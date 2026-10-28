import {Tracker} from './tracker';
import {SeasonalTracker} from './seasonal-tracker';
import type {SeasonalPhase, SeasonalType, Source, TrackerSnapshot, UnitOverlap} from '@/shared/contracts/engine';
import type {EmitFn} from './types';
import type {ItemFilterEngine} from './item-filter';
import type {FilterScope} from '@/shared/item-filter';
import {log} from '@/main/logger';

/** The flags a seasonal's row renders from: running vs frozen, and the owner ring. */
interface PublishedFlags {
  active: boolean;
  owner:  boolean;
}

export interface DistributeResult {
  sessionAccepted:  boolean;
  mapChanged:       boolean;
  seasonalsChanged: Set<SeasonalType>;
}

/**
 * TrackerRegistry — owns the collection of trackers, the writer rule, fan-out
 * to active scopes, bubble exclusivity, which seasonals the session pause
 * froze, and the saved unit (which map a seasonal run belongs to). Knows
 * nothing about log events.
 */
export class TrackerRegistry {
  session: Tracker | null = null;
  map:     Tracker | null = null;

  private _seasonals:  Map<SeasonalType, SeasonalTracker> = new Map();
  // The `{active, owner}` pair last published per seasonal (tracker_started or
  // tracker_update) — what the renderer currently shows. _emitOwnership diffs
  // against it, so a seasonal is republished only when that pair changed.
  private _published: Map<SeasonalType, PublishedFlags> = new Map();
  // ACTIVATION order — start pushes, gameplay reactivation bumps to the end.
  // writer() scans it from the end for the drop owner.
  private _startOrder: SeasonalType[]                     = [];
  // Writer cache. `undefined` = needs recompute, `null` = no writer.
  private _currentWriter: Source | null | undefined = undefined;
  // Seasonals the SESSION pause froze — whoever paused a tracker resumes it,
  // so only these are resumed by the session resume. See freezeForSessionPause.
  private _sessionFrozen: Set<SeasonalType> = new Set();
  // The last map ordinal handed out (Tracker.seq); 0 before the run's first map.
  private _mapSeq = 0;
  // Finished children of the CURRENT map, in finish order — its unit's overlaps.
  private _mapChildren: UnitOverlap[] = [];
  // False only inside discardForReset: a reset run saves nothing.
  private _emitUnits = true;

  // -----------------------------------------------------------------------
  // Lookup
  // -----------------------------------------------------------------------

  seasonal(type: SeasonalType): SeasonalTracker | null {
    return this._seasonals.get(type) ?? null;
  }

  seasonals(): IterableIterator<SeasonalTracker> {
    return this._seasonals.values();
  }

  seasonalsSize(): number {
    return this._seasonals.size;
  }

  hasBubble(): boolean {
    for (const t of this._seasonals.values()) if (t.ownsBubble) return true;
    return false;
  }

  // -----------------------------------------------------------------------
  // Lifecycle starters
  // -----------------------------------------------------------------------

  startSession(): Tracker {
    this.session = new Tracker('session');
    this._currentWriter = undefined;
    return this.session;
  }

  /** Every seasonal ACTIVE as the map starts (a town panel left open into it)
   *  becomes its child; a dormant one only if it wakes under it. */
  startMap(): Tracker | null {
    if (this.hasBubble()) return null;
    this.map = new Tracker('map');
    this.map.seq = ++this._mapSeq;
    for (const t of this._seasonals.values()) {
      if (t.active) this._stampParent(t);
    }
    this._currentWriter = undefined;
    return this.map;
  }

  /**
   * Activate a seasonal from a gameplay trigger: start it if absent, wake it
   * if self-paused (a reactivation — bumps it to newest in the ownership
   * order). The single entry point for seasonal trigger events.
   */
  activateSeasonal(opts: {
    type:               SeasonalType;
    ownsBubble?:        boolean;
    phase?:             SeasonalPhase;
    lootDurationMs?:    number;
    pauseOnLootExpiry?: boolean;
  }, emit: EmitFn): SeasonalTracker | null {
    const existing = this._seasonals.get(opts.type);
    if (existing) {
      if (!existing.active) existing.resumeTracker();
      return existing;
    }
    return this.startSeasonal(opts, emit);
  }

  /**
   * The loot-window wake rule, and THE place the pause rule for loot windows
   * lives. Every arm/reset on a dormant tracker comes through here: arming is
   * gameplay engagement, so the tracker wakes (a reactivation) and credits the
   * window, rather than holding a live window that rejects every drop.
   *
   * Blocked (false → the caller arms nothing) while the session is paused, and
   * for a tracker no longer registered for its type, so a finished run is never
   * revived. A missing session counts as not paused.
   */
  wakeForLoot(t: SeasonalTracker): boolean {
    if (t.active) return true;
    if (this._seasonals.get(t.seasonalType) !== t) return false;
    if (this.session && !this.session.active) return false;
    t.resumeTracker();
    return true;
  }

  /**
   * Start a seasonal tracker. Idempotent for the same type. Bubble rule:
   *   - Starting a bubble seasonal evicts every active non-bubble seasonal.
   *   - Starting a non-bubble while a bubble is up is a silent no-op.
   */
  startSeasonal(opts: {
    type:               SeasonalType;
    ownsBubble?:        boolean;
    phase?:             SeasonalPhase;
    lootDurationMs?:    number;
    pauseOnLootExpiry?: boolean;
    claimsDrops?:       boolean;
  }, emit: EmitFn): SeasonalTracker | null {
    const type       = opts.type;
    const ownsBubble = opts.ownsBubble ?? false;

    const existing = this._seasonals.get(type);
    if (existing) return existing;

    if (ownsBubble) {
      for (const otherType of [...this._startOrder]) {
        this._seasonals.get(otherType)?.finish();
      }
    } else if (this.hasBubble()) {
      log.debug('engine', `${type} start ignored: bubble seasonal active`);
      return null;
    }

    const tracker = new SeasonalTracker({
      registry:          this,
      emit,
      type,
      ownsBubble,
      phase:             opts.phase,
      lootDurationMs:    opts.lootDurationMs,
      pauseOnLootExpiry: opts.pauseOnLootExpiry,
      claimsDrops:       opts.claimsDrops,
    });
    // Stamped at creation whatever follows: a run started under a map is its
    // child even if the map then freezes (Clockwork podium, hub while paused).
    this._stampParent(tracker);
    this._seasonals.set(type, tracker);
    this._startOrder.push(type);
    this._currentWriter = undefined;
    // Newest → owner, unless timing-only (claimsDrops): the stamp reads writer().
    const snap = this._snapshotWithOwner(tracker);
    this._record(snap);
    emit({type: 'tracker_started', tracker: snap, timestamp: Date.now()});
    this._emitOwnership(emit);              // whoever held it before must drop the flag
    return tracker;
  }

  // -----------------------------------------------------------------------
  // Tracker callbacks
  // -----------------------------------------------------------------------

  /** Internal: SeasonalTracker.finish() calls this once it has cancelled its
   *  timer. The tracker passes the snapshot it took before signalling so the
   *  registry can emit tracker_finished with the correct state. */
  _onSeasonalFinished(tracker: SeasonalTracker, emit: EmitFn): void {
    const type = tracker.seasonalType;
    if (!this._seasonals.has(type)) return;
    const snap = tracker.snapshot();
    this._seasonals.delete(type);
    const idx = this._startOrder.indexOf(type);
    if (idx >= 0) this._startOrder.splice(idx, 1);
    this._published.delete(type);
    this._sessionFrozen.delete(type);
    this._currentWriter = undefined;
    const now = Date.now();
    emit({type: 'tracker_finished', tracker: snap, timestamp: now});
    this._unitForSeasonal(tracker, snap, now, emit);
    this._emitOwnership(emit); // ownership falls to whoever is now newest
  }

  /** Internal: a seasonal paused, or resumed without a reactivation (session
   *  resume). The renderer freezes a row's clock on `active: false`, so the
   *  flip MUST reach it — and does, because _emitOwnership diffs `active` as
   *  well as `owner`: a timing-only tracker (see SeasonalTracker.claimsDrops),
   *  which has no ownership to change, still publishes its park and its wake. */
  _onSeasonalStateChanged(tracker: SeasonalTracker, emit: EmitFn): void {
    if (tracker.active) this._stampParent(tracker);   // a session thaw under a map
    this._currentWriter = undefined;
    this._emitOwnership(emit);
  }

  /** Internal: a seasonal was re-activated by gameplay (e.g. a fresh Lunaria
   *  strum while an Overrealm run is live). Ownership follows recency of
   *  ACTIVATION, not creation — bump it to newest in the activation order so
   *  writer() picks it. Session-resume restores state without calling this.
   *
   *  Idempotent: bumping the tracker that is already newest changes nothing,
   *  so re-arming the current owner publishes no tracker_update (its
   *  loot_window_started carries the new deadline). A wake publishes once —
   *  the resume flips `active`; the arm's ownership bump after it is a no-op. */
  _onSeasonalReactivated(tracker: SeasonalTracker, emit: EmitFn): void {
    this._stampParent(tracker);
    const type = tracker.seasonalType;
    const idx = this._startOrder.indexOf(type);
    if (idx >= 0) {
      this._startOrder.splice(idx, 1);
      this._startOrder.push(type);
    }
    this._currentWriter = undefined;
    this._emitOwnership(emit);
  }

  /** Turn drop ownership on or off for a live seasonal without touching its
   *  clock — see SeasonalTracker.claimsDrops. Ownership is registry state, so
   *  the cached writer must be dropped and the change fanned out here rather
   *  than by the handler. Granting it also bumps the tracker to newest, so a
   *  mechanic that finally claims its loot outranks anything started meanwhile. */
  setSeasonalClaimsDrops(tracker: SeasonalTracker, claims: boolean, emit: EmitFn): void {
    if (tracker.claimsDrops === claims) return;
    tracker._setClaimsDrops(claims);
    if (claims) {
      this._onSeasonalReactivated(tracker, emit);
      return;
    }
    this._currentWriter = undefined;
    this._emitOwnership(emit);
  }

  // -----------------------------------------------------------------------
  // The saved unit
  // -----------------------------------------------------------------------
  //
  // A seasonal run is a CHILD of the map it was created or active under —
  // `this.map !== null` then, so a map frozen for an interlude or a session
  // pause still counts — and rides that map's `unit_finished` as an overlap.
  // Any other run is a STANDALONE unit. A seasonal sits under at most one map
  // (town finishes every seasonal, a bubble start the rest). Stamping emits
  // nothing. No session, no unit: a run that finishes before the bag baseline
  // is not the session's (the Engine stamps each unit with the session state).

  /** Units are emitted: a session exists and no reset is discarding the run. */
  private _unitsLive(): boolean {
    return this._emitUnits && this.session !== null;
  }

  /** Record the current map, if any, as `t`'s parent. */
  private _stampParent(t: SeasonalTracker): void {
    if (this.map) t.parentMapSeq = this.map.seq;
  }

  /** A seasonal just finished: held for the current map's unit if it is that
   *  map's child, else emitted as a standalone unit now. */
  private _unitForSeasonal(t: SeasonalTracker, snap: TrackerSnapshot, timestamp: number, emit: EmitFn): void {
    if (!this._unitsLive()) return;
    if (this.map !== null && t.parentMapSeq === this.map.seq) {
      this._mapChildren.push({tracker: snap, timestamp});
      return;
    }
    emit({type: 'unit_finished', tracker: snap, overlaps: [], timestamp});
  }

  /** Session stop mid-map: the live map is dropped, so its already-finished
   *  children are saved as standalone units, each at its own finish time.
   *  Must run before the session's tracker_finished. */
  promoteMapChildren(emit: EmitFn): void {
    const children = this._mapChildren;
    this._mapChildren = [];
    if (!this._unitsLive()) return;
    for (const c of children) {
      emit({type: 'unit_finished', tracker: c.tracker, overlaps: [], timestamp: c.timestamp});
    }
  }

  // -----------------------------------------------------------------------
  // Publishing seasonal state
  // -----------------------------------------------------------------------
  //
  // The renderer REPLACES a seasonal's snapshot on every tracker_update, so
  // each one must carry the true `owner` flag — an update without it reads as
  // "not the owner", and the overlay's owner ring would blink off on every
  // drop. Hence a single emitter: every seasonal tracker_update goes through
  // emitUpdate, which stamps the flag and records what was published. Updates
  // are sent on a real change only — drops/elapsed (publishDrops) or a changed
  // `{active, owner}` pair (_emitOwnership). Map/session snapshots never carry
  // `owner` (no consumer; see TrackerSnapshot.owner).

  /** THE seasonal tracker_update emitter: the snapshot stamped with `owner`
   *  (= this tracker is the current writer()), recorded as the pair the
   *  renderer now shows. */
  emitUpdate(tracker: SeasonalTracker, emit: EmitFn): void {
    const snap = this._snapshotWithOwner(tracker);
    this._record(snap);
    emit({type: 'tracker_update', tracker: snap, timestamp: Date.now()});
  }

  /** The change detector: republish every live seasonal whose `{active,
   *  owner}` pair differs from what it last published. Ownership is a property
   *  of the SET — one seasonal gaining it means another lost it, and the loser
   *  needs a snapshot too or the UI would show two owners — so every seasonal
   *  is checked, not only the one whose change triggered the call. A call that
   *  changed nothing publishes nothing. */
  private _emitOwnership(emit: EmitFn): void {
    const owner = this.writer();
    for (const t of this._seasonals.values()) {
      const last = this._published.get(t.seasonalType);
      if (last && last.active === t.active && last.owner === (t.seasonalType === owner)) continue;
      this.emitUpdate(t, emit);
    }
  }

  /** Snapshot stamped with the drop-ownership flag. */
  private _snapshotWithOwner(tracker: SeasonalTracker): TrackerSnapshot {
    const snap = tracker.snapshot();
    snap.owner = tracker.seasonalType === this.writer();
    return snap;
  }

  private _record(snap: TrackerSnapshot): void {
    if (!snap.seasonalType) return;
    this._published.set(snap.seasonalType, {active: snap.active, owner: snap.owner === true});
  }

  // -----------------------------------------------------------------------
  // Fan-out
  // -----------------------------------------------------------------------

  /** Pause the active map tracker (e.g. while an Arcana fight interrupts a map
   *  run). No-op if there's no map or it's already paused. Invalidates the
   *  writer cache since a paused map can't be the drop writer. Emits a
   *  tracker_update so the renderer freezes the map row's timer — mirrors
   *  _onSeasonalStateChanged for seasonal pause/resume. */
  pauseMap(emit: EmitFn): void {
    if (!this.map || !this.map.active) return;
    this.map.pause();
    this._currentWriter = undefined;
    emit({type: 'tracker_update', tracker: this.map.snapshot(), timestamp: Date.now()});
  }

  /** Resume a paused map tracker (e.g. returning to the map after an Arcana
   *  fight). No-op if there's no map or it's already running. */
  resumeMap(emit: EmitFn): void {
    if (!this.map || this.map.active) return;
    this.map.resume();
    this._currentWriter = undefined;
    emit({type: 'tracker_update', tracker: this.map.snapshot(), timestamp: Date.now()});
  }

  /**
   * The drop OWNER — the source label for the session's per-source breakdown.
   * Most recently ACTIVATED live seasonal (not creation order), else the map.
   * The map must be `active`: a map frozen for an interlude rejects drops at
   * Tracker.addDrop, so crediting 'map' would book qty no map row ever saw.
   */
  writer(): Source | null {
    if (this._currentWriter !== undefined) return this._currentWriter;
    let writer: Source | null = null;
    for (let i = this._startOrder.length - 1; i >= 0; i--) {
      const t = this._seasonals.get(this._startOrder[i]);
      // A timing-only tracker (claimsDrops: false) is skipped rather than
      // treated as the owner, so drops fall through to the next candidate —
      // in practice the map. See SeasonalTracker.claimsDrops.
      if (t && t.active && t.claimsDrops) { writer = this._startOrder[i]; break; }
    }
    if (writer === null && this.map !== null && this.map.active) writer = 'map';
    this._currentWriter = writer;
    return writer;
  }

  /**
   * Drop-through attribution: a drop credits EVERY live tier it happened
   * inside, so the map row is a superset of the in-map seasonals running
   * inside it. `this.map.active` is the whole gate — interludes that aren't
   * part of playing the map already freeze it (Arcana/Vorex panel+fight,
   * map→Sandlord hub) and Sandlord's bubble suppresses the map tracker
   * outright, so their loot never drops through.
   *
   * Each tier gates on its own scope filter independently. `dropsBySource`
   * stays single-owner so the by-source pie still sums to exactly session FE.
   */
  distributeDrop(itemId: number, change: number, filter: ItemFilterEngine | null): DistributeResult {
    const result: DistributeResult = {
      sessionAccepted:  false,
      mapChanged:       false,
      seasonalsChanged: new Set(),
    };

    const sessionIncluded = !filter || filter.shouldInclude(itemId, 'session' as FilterScope);
    if (sessionIncluded && this.session) {
      this.session.addDrop(itemId, change);
      result.sessionAccepted = true;
    }

    const owner = this.writer();

    if (owner !== null && owner !== 'map') {
      const tracker = this._seasonals.get(owner);
      if (tracker && tracker.active && (!filter || filter.shouldInclude(itemId, owner as FilterScope))) {
        tracker.addDrop(itemId, change);
        result.seasonalsChanged.add(owner);
      }
    }

    if (this.map && this.map.active && (!filter || filter.shouldInclude(itemId, 'map' as FilterScope))) {
      this.map.addDrop(itemId, change);
      result.mapChanged = true;
    }

    if (sessionIncluded && this.session && owner !== null) {
      this.session.addDropToSource(owner, itemId, change);
    }
    return result;
  }

  /**
   * Book a town → map entry cost: it becomes the map's cost (replacing any)
   * and adds to the session's running total. Never a drop, never a seasonal's,
   * and deliberately unfiltered — hiding an item hides its loot, not what the
   * map cost.
   */
  chargeEntryCost(cost: ReadonlyMap<number, number>): void {
    this.map?.setEntryCost(cost);
    if (this.session) {
      for (const [itemId, qty] of cost) this.session.addCost(itemId, qty);
    }
  }

  // -----------------------------------------------------------------------
  // Session pause
  // -----------------------------------------------------------------------

  /** Freeze one seasonal for the session pause — at pause time, or when it
   *  starts while the session is already paused. A running tracker is paused
   *  and remembered so the session resume restarts it; a self-paused one
   *  (Lunaria between strums, a backed-out Arcana) is left alone and stays
   *  paused across the resume. An in-flight loot window freezes either way. */
  freezeForSessionPause(tracker: SeasonalTracker): void {
    if (tracker.active) {
      tracker.pauseTracker();
      this._sessionFrozen.add(tracker.seasonalType);
    }
    tracker.freezeLootTimer();
  }

  /** Session pause: freeze every live seasonal, oldest activation first, so
   *  the owner is frozen last and ownership never passes to a tracker that is
   *  about to freeze — each publishes only its `active: false`. */
  freezeAllForSessionPause(): void {
    for (const type of [...this._startOrder]) {
      const t = this._seasonals.get(type);
      if (t) this.freezeForSessionPause(t);
    }
  }

  /** Session resume: continue every frozen loot window, then resume only the
   *  seasonals the session pause froze. Frozen windows can't expire during a
   *  pause, so a tracker self-paused at pause time is still self-paused here.
   *  The resume is mechanical — it restores the pre-pause ownership order
   *  rather than bumping the tracker to newest — and runs newest first, so the
   *  pre-pause owner is back before any older tracker could claim the flag in
   *  between. */
  thawSessionPause(): void {
    for (const t of this._seasonals.values()) t.unfreezeLootTimer();
    for (const type of [...this._startOrder].reverse()) {
      if (this._sessionFrozen.has(type)) this._seasonals.get(type)?.resumeTracker({reactivate: false});
    }
    this._sessionFrozen.clear();
  }

  // -----------------------------------------------------------------------
  // Mass teardown
  // -----------------------------------------------------------------------

  /** Finish every active seasonal — each emits its own tracker_finished. */
  finishAllSeasonals(): void {
    for (const tracker of [...this._seasonals.values()]) {
      tracker.finish();
    }
  }

  /** Finish all seasonals, then the map tracker. ZoneHandler town path.
   *  Seasonals first, so every child is collected before the map's unit. */
  finishAll(emit: EmitFn): void {
    this.finishAllSeasonals();
    if (this.map) this._finishMap(this.map, emit);
  }

  /** The map's own tracker_finished, then its unit: the same snapshot (entry
   *  cost on its `spent`) with the children collected while it ran. */
  private _finishMap(map: Tracker, emit: EmitFn): void {
    const snap = map.snapshot();
    this.map = null;
    this._currentWriter = undefined;
    const now = Date.now();
    emit({type: 'tracker_finished', tracker: snap, timestamp: now});
    const overlaps = this._mapChildren;
    this._mapChildren = [];
    if (this._unitsLive()) emit({type: 'unit_finished', tracker: snap, overlaps, timestamp: now});
  }

  /** Engine.reset: the plain tracker_finished of every seasonal and the map,
   *  which the renderer needs to drop their rows, but NO unit — the reset run
   *  is discarded, nothing of it is saved. */
  discardForReset(emit: EmitFn, timestamp: number): void {
    this._emitUnits = false;
    try {
      this.finishAllSeasonals();
    } finally {
      this._emitUnits = true;
    }
    this._mapChildren = [];
    if (this.map) {
      emit({type: 'tracker_finished', tracker: this.map.snapshot(), timestamp});
      this.map = null;
    }
    this._currentWriter = undefined;
  }

  /** Drop every tracker silently (no events) — EngineContext.reset(), where
   *  the engine has its own emission policy, and bag-init completion, which
   *  drops the unannounced pre-init state. Cancels seasonal loot timers as a
   *  side-effect so no callbacks fire after teardown. */
  reset(): void {
    for (const t of this._seasonals.values()) t.cancelLootTimer();
    this.session = null;
    this.map     = null;
    this._seasonals.clear();
    this._startOrder = [];
    this._published.clear();
    this._sessionFrozen.clear();
    this._currentWriter = undefined;
    this._mapSeq        = 0;
    this._mapChildren   = [];
  }
}
