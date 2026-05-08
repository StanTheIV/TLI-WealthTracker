import {BagState} from './bag-state';
import {Tracker} from './tracker';
import type {SeasonalType, Source} from './tracker';
import type {ItemFilterEngine} from './item-filter';
import type {FilterScope} from '@/types/itemFilter';

/** Result of a single drop fan-out — tells the publisher which trackers
 *  actually accumulated the drop so it only emits `tracker_update` for those. */
export interface DistributeResult {
  sessionAccepted:  boolean;
  mapChanged:       boolean;
  seasonalsChanged: Set<SeasonalType>;
}

export type Phase = 'idle' | 'initializing' | 'tracking';

/** Session data to merge into the engine after bag initialization completes. */
export interface LoadedSessionData {
  id:        string;
  name:      string;
  /** Drops from the previous run, with string keys (as stored in DB). */
  drops:     Record<string, number>;
  /** Total elapsed seconds from the previous run. */
  totalTime: number;
  /** Map time seconds from the previous run. */
  mapTime:   number;
  mapCount:  number;
}

/**
 * Shared mutable state accessible by all event handlers.
 * The engine owns this instance and resets it on start/stop.
 * Handlers read and write freely — safe because Node.js is single-threaded.
 */
export class EngineContext {
  phase:        Phase    = 'idle';
  paused:       boolean  = false;
  bag:          BagState = new BagState();
  inMap:        boolean  = false;
  currentScene: string   = '';
  mapCount:     number   = 0;
  mapStartTime: number   = 0;

  /** Cumulative elapsed ms of all completed maps in this session. */
  accumulatedMapTime: number = 0;

  /** Set before engine.start() to continue a previous session. Cleared after init. */
  loadedSession: LoadedSessionData | null = null;

  /** Non-null when continuing an existing saved session. */
  activeSessionId:   string | null = null;
  activeSessionName: string | null = null;

  // Three tracker scopes. Session and map are still single-slot. Seasonals
  // can run concurrently (Lunaria-during-Overrealm in Netherrealm), so
  // `seasonals` is a Map keyed by SeasonalType. `seasonalsStartOrder` mirrors
  // it as an ordered list (oldest → newest) used to pick the session writer.
  session:               Tracker | null               = null;
  map:                   Tracker | null               = null;
  seasonals:             Map<SeasonalType, Tracker>   = new Map();
  seasonalsStartOrder:   SeasonalType[]               = [];

  // Memoized writer (newest-active seasonal, or 'map', or null). Recomputed
  // on miss; invalidated whenever a seasonal starts/finishes/pauses/resumes
  // or the map tracker comes/goes. Using `undefined` to mean "not computed"
  // (vs `null` which means "computed and there is no writer").
  private _currentWriter: Source | null | undefined = undefined;

  /** Active filter engine — null means no filtering (all items pass). */
  filter: ItemFilterEngine | null = null;

  /** IDs of items already known in the DB — used to detect first-time drops. */
  knownItems: Set<string> = new Set();

  /**
   * True when a tracker that should receive drops is currently active —
   * either a regular map tracker or any seasonal tracker. Used by
   * publishDrops to gate tracker fan-out and the renderer-facing `drop`
   * event so town activity (no map, no seasonal) doesn't pollute earnings.
   */
  isLootContext(): boolean {
    return this.map !== null || this.seasonals.size > 0;
  }

  /** True iff any active seasonal tracker has `ownsBubble: true` (Sandlord).
   *  ZoneHandler reads this to skip per-map tracker creation inside a bubble;
   *  startSeasonal reads it to refuse non-bubble seasonals while a bubble is
   *  active. */
  hasSeasonalThatOwnsBubble(): boolean {
    for (const t of this.seasonals.values()) {
      if (t.ownsBubble) return true;
    }
    return false;
  }

  /**
   * Source that gets writer-attribution credit for the next drop:
   *   1. Newest seasonal in `seasonalsStartOrder` whose tracker is active.
   *   2. Else if a map tracker exists → 'map'.
   *   3. Else null (drops in this state shouldn't reach here — publishDrops
   *      already gates on `isLootContext()`).
   *
   * Memoized on `_currentWriter`; helpers invalidate via `invalidateWriter()`
   * on every state change so the next read recomputes. Hot-path; called per
   * drop.
   */
  getSessionWriter(): Source | null {
    if (this._currentWriter !== undefined) return this._currentWriter;
    let writer: Source | null = null;
    for (let i = this.seasonalsStartOrder.length - 1; i >= 0; i--) {
      const t = this.seasonals.get(this.seasonalsStartOrder[i]);
      if (t && t.active) {
        writer = this.seasonalsStartOrder[i];
        break;
      }
    }
    if (writer === null && this.map !== null) writer = 'map';
    this._currentWriter = writer;
    return writer;
  }

  /** Drop the writer cache. Called by seasonal-helpers and by code that mutates
   *  `this.map` or seasonal pause state. */
  invalidateWriter(): void {
    this._currentWriter = undefined;
  }

  /**
   * Fan a drop out to active trackers, applying per-scope filter rules.
   * Called by publishDrops — the single drop entry point.
   *
   * Returns a `DistributeResult` describing which trackers accumulated the
   * drop so the publisher only emits `tracker_update` for those. With per-
   * scope filter rules, a drop can be accepted by some seasonals' filters
   * and rejected by others; the result captures that exactly.
   *
   * Also writes the drop to the session tracker's per-source breakdown via
   * `getSessionWriter()` — that's what powers the source-breakdown pie.
   */
  distributeDrop(itemId: number, change: number): DistributeResult {
    const f = this.filter;
    const result: DistributeResult = {
      sessionAccepted:  false,
      mapChanged:       false,
      seasonalsChanged: new Set(),
    };

    const sessionIncluded = !f || f.shouldInclude(itemId, 'session' as FilterScope);
    if (sessionIncluded && this.session) {
      this.session.addDrop(itemId, change);
      result.sessionAccepted = true;
    }
    if (this.map && (!f || f.shouldInclude(itemId, 'map' as FilterScope))) {
      this.map.addDrop(itemId, change);
      result.mapChanged = true;
    }
    for (const [type, tracker] of this.seasonals) {
      if (!tracker.active) continue;
      if (f && !f.shouldInclude(itemId, type as FilterScope)) continue;
      tracker.addDrop(itemId, change);
      result.seasonalsChanged.add(type);
    }

    // Writer-attribution into session.dropsBySource. Only meaningful when the
    // session accepted the drop (otherwise the source-pie slice for that
    // drop's bucket would not match the session total).
    if (sessionIncluded && this.session) {
      const writer = this.getSessionWriter();
      if (writer !== null) this.session.addDropToSource(writer, itemId, change);
    }

    return result;
  }

  reset(): void {
    this.phase             = 'idle';
    this.paused            = false;
    this.bag.reset();
    this.inMap             = false;
    this.currentScene      = '';
    this.mapCount          = 0;
    this.mapStartTime      = 0;
    this.accumulatedMapTime = 0;
    this.loadedSession     = null;
    this.activeSessionId   = null;
    this.activeSessionName = null;
    this.session           = null;
    this.map               = null;
    this.seasonals.clear();
    this.seasonalsStartOrder = [];
    this._currentWriter    = undefined;
    this.filter            = null;
    this.knownItems        = new Set();
  }
}
