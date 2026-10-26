import {BagState, type SlotChange} from './bag-state';
import {TrackerRegistry} from './tracker-registry';
import type {ItemFilterEngine} from './item-filter';
import type {ItemType} from '@/types/itemType';

export type {DistributeResult} from './tracker-registry';

export type Phase = 'idle' | 'initializing' | 'tracking';

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
  inMap:        boolean  = false;
  currentScene: string   = '';
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

  reset(): void {
    this.phase             = 'idle';
    this.paused            = false;
    this.mapPausedForInterludeAt = null;
    this.bag.reset();
    this.bagDeltas         = [];
    this.inMap             = false;
    this.currentScene      = '';
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
