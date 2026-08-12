import {Tracker} from './tracker';
import {SeasonalTracker} from './seasonal-tracker';
import type {SeasonalPhase, SeasonalType, Source, TrackerSnapshot} from './tracker';
import type {EmitFn} from './types';
import type {ItemFilterEngine} from './item-filter';
import type {FilterScope} from '@/types/itemFilter';
import {log} from '@/main/logger';

export interface DistributeResult {
  sessionAccepted:  boolean;
  mapChanged:       boolean;
  seasonalsChanged: Set<SeasonalType>;
}

/**
 * TrackerRegistry — owns the collection of trackers, the writer rule, fan-out
 * to active scopes, and bubble exclusivity. Knows nothing about log events.
 */
export class TrackerRegistry {
  session: Tracker | null = null;
  map:     Tracker | null = null;

  private _seasonals:  Map<SeasonalType, SeasonalTracker> = new Map();
  // Last `owner` flag published per seasonal, so ownership churn only emits for
  // trackers whose flag actually flipped.
  private _lastEmittedOwner: Map<SeasonalType, boolean> = new Map();
  // ACTIVATION order — start pushes, gameplay reactivation bumps to the end.
  // writer() scans it from the end for the drop owner.
  private _startOrder: SeasonalType[]                     = [];
  // Writer cache. `undefined` = needs recompute, `null` = no writer.
  private _currentWriter: Source | null | undefined = undefined;

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

  startMap(): Tracker | null {
    if (this.hasBubble()) return null;
    this.map = new Tracker('map');
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
    this._seasonals.set(type, tracker);
    this._startOrder.push(type);
    this._currentWriter = undefined;
    // Starting normally makes it the newest → owner, but a timing-only tracker
    // never holds the flag, and seeding `true` would suppress the corrective
    // update that _emitOwnership only sends on a CHANGE.
    this._lastEmittedOwner.set(type, tracker.claimsDrops);
    emit({type: 'tracker_started', tracker: this._snapshotWithOwner(tracker), timestamp: Date.now()});
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
    this._lastEmittedOwner.delete(type);
    this._currentWriter = undefined;
    emit({type: 'tracker_finished', tracker: snap, timestamp: Date.now()});
    this._emitOwnership(emit); // ownership falls to whoever is now newest
  }

  /** Internal: a seasonal paused or resumed. The renderer freezes a row's clock
   *  on `active: false`, so this state MUST reach it — hence the forced emit.
   *  Ownership alone would not do it: a tracker that never owns drops (a
   *  timing-only one, see SeasonalTracker.claimsDrops) has no ownership change
   *  to publish, so it would park silently and its row keep ticking. */
  _onSeasonalStateChanged(tracker: SeasonalTracker, emit: EmitFn): void {
    this._currentWriter = undefined;
    this._emitOwnership(emit, tracker.seasonalType);
  }

  /** Internal: a seasonal was re-activated by gameplay (e.g. a fresh Lunaria
   *  strum while an Overrealm run is live). Ownership follows recency of
   *  ACTIVATION, not creation — bump it to newest in the activation order so
   *  writer() picks it. Session-resume restores state without calling this. */
  _onSeasonalReactivated(tracker: SeasonalTracker, emit: EmitFn): void {
    const type = tracker.seasonalType;
    const idx = this._startOrder.indexOf(type);
    if (idx >= 0) {
      this._startOrder.splice(idx, 1);
      this._startOrder.push(type);
    }
    this._currentWriter = undefined;
    // Forced for the same reason as the pause path: waking a timing-only
    // tracker changes no ownership, but the row must start ticking again.
    this._emitOwnership(emit, type);
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

  /** Emit a tracker_update for every live seasonal whose `owner` flag changed.
   *  Ownership is a property of the SET — one seasonal gaining it means another
   *  lost it, and the loser needs a snapshot too or the UI would show two owners.
   *
   *  `force` names a seasonal to emit even when its ownership is unchanged, for
   *  callers publishing some OTHER state on it (pause/resume). Routing that
   *  through here rather than emitting separately is what keeps it to exactly
   *  one update per tracker. */
  private _emitOwnership(emit: EmitFn, force?: SeasonalType): void {
    const owner = this.writer();
    for (const t of this._seasonals.values()) {
      const isOwner = t.seasonalType === owner;
      if (this._lastEmittedOwner.get(t.seasonalType) === isOwner && t.seasonalType !== force) continue;
      this._lastEmittedOwner.set(t.seasonalType, isOwner);
      emit({type: 'tracker_update', tracker: this._snapshotWithOwner(t, owner), timestamp: Date.now()});
    }
  }

  /** Snapshot stamped with the drop-ownership flag. */
  _snapshotWithOwner(tracker: SeasonalTracker, owner?: Source | null): TrackerSnapshot {
    const snap = tracker.snapshot();
    snap.owner = tracker.seasonalType === (owner === undefined ? this.writer() : owner);
    return snap;
  }

  // -----------------------------------------------------------------------
  // Fan-out
  // -----------------------------------------------------------------------

  isLootContext(): boolean {
    return this.map !== null || this._seasonals.size > 0;
  }

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

  invalidateWriter(): void {
    this._currentWriter = undefined;
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

  // -----------------------------------------------------------------------
  // Mass teardown
  // -----------------------------------------------------------------------

  /** Finish every active seasonal — each emits its own tracker_finished. */
  finishAllSeasonals(): void {
    for (const tracker of [...this._seasonals.values()]) {
      tracker.finish();
    }
  }

  /** Finish all seasonals, then the map tracker. ZoneHandler town path. */
  finishAll(emit: EmitFn): void {
    this.finishAllSeasonals();
    if (this.map) {
      const snap = this.map.snapshot();
      this.map = null;
      this._currentWriter = undefined;
      emit({type: 'tracker_finished', tracker: snap, timestamp: Date.now()});
    }
  }

  /** Drop every tracker silently (no events). Used by Engine.stop()/reset()
   *  where the engine has its own emission policy. Cancels seasonal loot
   *  timers as a side-effect so no callbacks fire after teardown. */
  reset(): void {
    for (const t of this._seasonals.values()) t.cancelLootTimer();
    this.session = null;
    this.map     = null;
    this._seasonals.clear();
    this._startOrder = [];
    this._currentWriter = undefined;
  }
}
