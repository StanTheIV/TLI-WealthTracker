import {BagState, type SlotChange} from './bag-state';
import {TrackerRegistry} from './tracker-registry';
import type {ItemFilterEngine} from './item-filter';
import type {ItemType} from '@/shared/items';

export type {DistributeResult} from './tracker-registry';

export type Phase = 'idle' | 'initializing' | 'tracking';

/**
 * Where the player is, by scene (see ZoneHandler's classification):
 *   town           — the hideout; bag activity there is prep, never loot.
 *   map            — a regular map, or a zone entered from one.
 *   seasonal-scene — a dedicated seasonal scene (Arcana fight, Vorex reward
 *                    zone, Tartarus prison); never a map.
 *   hub            — the Sandlord hub and the sub-maps entered from it.
 *   other          — any scene nothing recognises (login, character select…),
 *                    and the initial value before the first transition.
 */
export type Location = 'town' | 'map' | 'seasonal-scene' | 'hub' | 'other';

/** The most recent zone transition, as ZoneHandler resolved it. */
export interface LocationTransition {
  from:       Location;
  to:         Location;
  /** This transition created a map tracker. */
  mapStarted: boolean;
}

/** Session data to merge into the engine after bag initialization completes. */
export interface LoadedSessionData {
  id:        string;
  name:      string;
  drops:     Record<string, number>;
  totalTime: number;
  mapTime:   number;
  mapCount:  number;
}

/**
 * Shared mutable state accessible by all event handlers. The engine owns this
 * instance and resets it on start/stop. Tracker-related state lives on the
 * registry, not directly on the context.
 */
export class EngineContext {
  phase:        Phase    = 'idle';
  paused:       boolean  = false;
  /** Wall-clock ms when a seasonal interlude (Arcana tarot/fight, Vorex
   *  window/fight zone, map→Sandlord hub) paused the map tracker; null when
   *  none is in flight. Cross-cutting: Engine.resume() reads it to leave a map
   *  frozen across a session resume while its interlude is still ongoing.
   *  See map-interlude.ts. */
  mapPausedForInterludeAt: number | null = null;
  bag:          BagState = new BagState();
  /** Per-item inventory deltas the CURRENT raw event produced — set by
   *  ItemHandler, read by later handlers (MapMaterial). Engine.onRawEvent
   *  clears it before routing each event, so it can never describe an
   *  earlier one. */
  bagDeltas:    readonly SlotChange[] = [];
  /** A map run exists (its tracker may be frozen for an interlude) — NOT
   *  "the player is in a map"; that is `location`. */
  inMap:        boolean  = false;
  currentScene: string   = '';

  /** Where the player is now, and was before the last transition. Written
   *  only by ZoneHandler, on every zone_transition regardless of phase or
   *  pause; survives Engine.reset(). */
  location:     Location = 'other';
  prevLocation: Location = 'other';
  /** The last zone transition; null until the first one. */
  transition:   LocationTransition | null = null;
  mapCount:     number   = 0;

  /** Cumulative elapsed ms of all completed maps in this session. */
  accumulatedMapTime: number = 0;

  /** Set before engine.start() to continue a previous session. Cleared after init. */
  loadedSession: LoadedSessionData | null = null;

  /** Non-null when continuing an existing saved session. */
  activeSessionId:   string | null = null;
  activeSessionName: string | null = null;

  registry: TrackerRegistry = new TrackerRegistry();

  /** Active filter engine — null means no filtering (all items pass). */
  filter: ItemFilterEngine | null = null;

  /** Item id → type. One instance for the context's lifetime: the filter is
   *  built over it, so a type learned mid-session reaches the filter as-is. */
  readonly itemTypes = new Map<string, ItemType>();

  /** IDs of items already known in the DB — used to detect first-time drops. */
  knownItems: Set<string> = new Set();

  /** Bag changes here are loot (credited) rather than town activity. A pure
   *  function of where the player is: which trackers happen to exist is
   *  irrelevant — a seasonal panel open in town does not make town loot. */
  isLootContext(): boolean {
    return this.location === 'map' || this.location === 'seasonal-scene' || this.location === 'hub';
  }

  reset(): void {
    this.phase             = 'idle';
    this.paused            = false;
    this.mapPausedForInterludeAt = null;
    this.bag.reset();
    this.bagDeltas         = [];
    this.inMap             = false;
    this.currentScene      = '';
    this.location          = 'other';
    this.prevLocation      = 'other';
    this.transition        = null;
    this.mapCount          = 0;
    this.accumulatedMapTime = 0;
    this.loadedSession     = null;
    this.activeSessionId   = null;
    this.activeSessionName = null;
    this.registry.reset();
    this.filter            = null;
    this.itemTypes.clear();
    this.knownItems        = new Set();
  }
}
