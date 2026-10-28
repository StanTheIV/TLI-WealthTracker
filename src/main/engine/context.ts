import {BagState, type SlotChange} from './bag-state';
import {TrackerRegistry} from './tracker-registry';
import type {ItemFilterEngine} from './item-filter';
import type {ItemType} from '@/shared/items';
import type {Source} from '@/shared/contracts/engine';
import type {EmitFn} from './types';

export type {DistributeResult} from './tracker-registry';

/** A registered handler's `onSessionOpen` (see EventHandler). */
export type SessionOpenHook = (ctx: EngineContext, emit: EmitFn) => void;

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

/** A saved session's run data, merged into the new session once the bag
 *  baseline lands (Continue). Item-id keyed as stored; times in SECONDS. The
 *  identity is not part of it — that comes from `Engine.start`. */
export interface LoadedSessionData {
  drops:         Record<string, number>;
  dropsBySource: Partial<Record<Source, Record<string, number>>>;
  spent:         Record<string, number>;
  totalTime:     number;
  mapTime:       number;
  mapCount:      number;
}

/**
 * Shared mutable state accessible by all event handlers. The engine owns this
 * instance and resets it on start/stop. Tracker-related state lives on the
 * registry, not directly on the context.
 */
export class EngineContext {
  phase:        Phase    = 'idle';
  paused:       boolean  = false;
  /** Wall-clock ms when a seasonal interlude (Arcana, Vorex, Tartarus,
   *  map→Sandlord hub) froze the current map; null when none did. Read-only:
   *  map state the registry owns and drops with the map. Engine.resume() reads
   *  it to leave a map frozen while its interlude is still up. See
   *  map-interlude.ts. */
  get mapPausedForInterludeAt(): number | null {
    return this.registry.mapInterludeAt;
  }
  bag:         BagState = new BagState();
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

  /** Set before engine.start() to continue a previous session. Cleared when
   *  the session opens. */
  loadedSession: LoadedSessionData | null = null;

  /** The open session continues a saved one (its `sessionMeta.continued`).
   *  Set by openSessionRun, which consumes `loadedSession`, and kept for the
   *  run so the session start can be replayed (Engine.getState). */
  sessionContinued: boolean = false;

  /** The session identity (see SessionIdentity): set by Engine.start and
   *  Engine.reset, null while idle. */
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

  /** Every registered handler's `onSessionOpen`, in registration order — run
   *  by openSessionRun. Here because the session opens from BagInitHandler,
   *  which cannot reach its sibling handlers. Wiring, not session state:
   *  filled once by Engine.register and deliberately left alone by reset(),
   *  since the handlers outlive every session. */
  readonly sessionOpenHooks: SessionOpenHook[] = [];

  /** Bag changes here are loot (credited) rather than town activity. A pure
   *  function of where the player is: which trackers happen to exist is
   *  irrelevant — a seasonal panel open in town does not make town loot. */
  isLootContext(): boolean {
    return this.location === 'map' || this.location === 'seasonal-scene' || this.location === 'hub';
  }

  reset(): void {
    this.phase             = 'idle';
    this.paused            = false;
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
    this.sessionContinued  = false;
    this.activeSessionId   = null;
    this.activeSessionName = null;
    this.registry.reset();
    this.filter            = null;
    this.itemTypes.clear();
    this.knownItems        = new Set();
  }
}
