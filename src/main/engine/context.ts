import {BagState} from './bag-state';
import {Tracker} from './tracker';
import type {ItemFilterEngine} from './item-filter';
import type {FilterScope} from '@/types/itemFilter';

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

  // Three tracker slots — null means that scope is not currently active
  session:  Tracker | null = null;
  map:      Tracker | null = null;
  seasonal: Tracker | null = null;

  /** Active filter engine — null means no filtering (all items pass). */
  filter: ItemFilterEngine | null = null;

  /** IDs of items already known in the DB — used to detect first-time drops. */
  knownItems: Set<string> = new Set();

  // Previous level type value — needed to detect Dream entry/exit transitions
  levelType: number = 3;

  // S13 Vorex state
  vorexAbandoning: boolean = false;   // s13_abandon seen; waiting for zone transition to resolve

  // S12 Overrealm state
  inOverrealm:      boolean = false;  // currently inside Overrealm stages
  overrealmExiting: boolean = false;  // portal 52 seen; waiting for zone transition to start loot timer

  /**
   * Fan a drop out to all active trackers, applying per-scope filter rules.
   * Called by ItemHandler._flush() — the single drop publisher.
   *
   * The seasonal scope key is derived from the active seasonal tracker's type
   * so Vorex, Dream, and Overrealm can each have independent filter rules.
   * Default when no filter is set: include all items.
   */
  distributeDrop(itemId: number, change: number): void {
    const f = this.filter;

    if (!f || f.shouldInclude(itemId, 'session' as FilterScope)) {
      this.session?.addDrop(itemId, change);
    }
    if (!f || f.shouldInclude(itemId, 'map' as FilterScope)) {
      this.map?.addDrop(itemId, change);
    }
    if (this.seasonal) {
      const seasonalScope = (this.seasonal.seasonalType ?? 'vorex') as FilterScope;
      if (!f || f.shouldInclude(itemId, seasonalScope)) {
        this.seasonal.addDrop(itemId, change);
      }
    }
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
    this.seasonal          = null;
    this.filter            = null;
    this.knownItems        = new Set();
    this.levelType         = 3;
    this.vorexAbandoning   = false;
    this.inOverrealm       = false;
    this.overrealmExiting  = false;
  }
}
