export type SeasonalType = 'vorex' | 'dream' | 'overrealm' | 'carjack' | 'clockwork' | 'sandlord' | 'lunaria' | 'arcana' | 'hunting' | 'afterlight' | 'tartarus';
/** A drop's owner for the per-source breakdown pie. 'map' covers drops where
 *  no seasonal owned the window; the SeasonalType variants cover drops where
 *  that seasonal was the most recently activated one. Note this is the
 *  breakdown owner only — under drop-through the map tracker also accrues
 *  drops owned by an in-map seasonal. */
export type Source = 'map' | SeasonalType;
export type TrackerKind = 'session' | 'map' | 'seasonal';
/** Sandlord runs in two phases sharing one seasonal type: 'map' — the in-map
 *  coin tile (in-map category, drop-through), 'hub' — the own-area hub bubble.
 *  Other seasonals leave this unset. */
export type SeasonalPhase = 'map' | 'hub';

export interface TrackerSnapshot {
  kind:          TrackerKind;
  drops:         Record<number, number>;
  /** Active run time (ms), pause-aware: session pauses, interlude freezes and
   *  dormancy do not count. */
  elapsed:       number;
  /** Wall-clock time (ms epoch) the tracker was created — the run's REAL
   *  start, fixed for its life. Not `finish − elapsed`, which reads late for a
   *  run that froze or went dormant. A map rebuilt by `Engine.reset` is a new
   *  tracker and starts at the reset; a continued session starts when it is
   *  continued. */
  startedAt:     number;
  seasonalType?: SeasonalType;
  /** Which Sandlord phase this tracker covers — see SeasonalPhase. */
  phase?:        SeasonalPhase;
  /** False while the tracker is paused (e.g. Lunaria between strum episodes —
   *  drops won't accrue but the tracker isn't finished). True for normal
   *  active seasonals. */
  active:        boolean;
  /** True on the seasonal that currently owns incoming drops — the one whose
   *  window was armed or re-armed most recently. Stamped by the registry on
   *  every seasonal tracker_started / tracker_update (ownership is registry
   *  state, not tracker state). Never set on map/session snapshots, nor on
   *  tracker_finished. */
  owner?:        boolean;
  /** Per-source breakdown — populated only on the session tracker's snapshot.
   *  Each drop is attributed to exactly one source (newest active tracker at
   *  the moment the drop fired) so summing per-source totals reproduces
   *  session FE. Omitted on map and seasonal snapshots. */
  dropsBySource?: Record<Source, Record<number, number>>;
  /** Entry cost, as positive magnitudes. Map: the materials consumed in town
   *  right before it started. Session: the running total of its maps' costs.
   *  Never in `drops`, never filtered. Omitted while empty (and on seasonals). */
  spent?:        Record<number, number>;
}

/** One seasonal run that finished inside a map unit, stamped with its OWN
 *  finish time (it may end long before the map does). */
export interface UnitOverlap {
  tracker:   TrackerSnapshot;
  timestamp: number;
}

/** Who the tracked session is. Owned by the tracking service (it generates
 *  the id and name, or hands over a continued session's); the engine only
 *  carries it, stamping it on the session `tracker_started`. */
export interface SessionIdentity {
  sessionId: string;
  name:      string;
}

/** A session's map counters: `mapTime` (ms) is the summed time of its
 *  finished maps, `mapCount` every map it has started (a live one included). */
export interface SessionMapMeta {
  mapTime:  number;
  mapCount: number;
}

/** The session `tracker_started` meta: the identity plus the counters the run
 *  starts from — the loaded values on a continue (`continued`), else zero —
 *  plus one for a map the player is already inside. */
export interface SessionStartMeta extends SessionIdentity, SessionMapMeta {
  continued: boolean;
}

/** The session state as of a `unit_finished`: the session snapshot (drops,
 *  dropsBySource, spent, elapsed) and its map counters at that moment. */
export interface UnitCheckpoint extends SessionMapMeta {
  session: TrackerSnapshot;
}

// ---------------------------------------------------------------------------
// EngineEvents — sent from the main-process engine to every renderer via IPC,
// except `unit_finished`, which stays in the main process (persistence only).
// ---------------------------------------------------------------------------

export type EngineEvent =
  | {type: 'init_started'}
  | {type: 'init_complete';    itemCount: number}
  | {type: 'drop';             itemId: number; change: number; timestamp: number}
  | {type: 'new_item';         itemId: number; timestamp: number}
  | {type: 'zone_change';      from: string; to: string; entering: 'map' | 'town' | 'unknown'; timestamp: number}
  | {type: 'map_started';      mapCount: number; timestamp: number}
  | {type: 'map_ended';        elapsed: number; timestamp: number}
  /** `sessionMeta`: on the SESSION tracker's start only. */
  | {type: 'tracker_started';  tracker: TrackerSnapshot; timestamp: number; sessionMeta?: SessionStartMeta}
  | {type: 'tracker_update';   tracker: TrackerSnapshot; timestamp: number}
  /** `sessionMeta`: on the SESSION tracker's finish only. */
  | {type: 'tracker_finished'; tracker: TrackerSnapshot; timestamp: number; sessionMeta?: SessionMapMeta}
  /** The saved unit, built by the engine: a map with the seasonal runs that
   *  were its children (`overlaps`, in finish order), or a STANDALONE seasonal
   *  run (`overlaps` empty). Emitted after the primary's own tracker_finished;
   *  `timestamp` is the primary's finish time; `checkpoint` is the session
   *  state as of this unit. Emitted only while a session exists: a run that
   *  finishes before the bag baseline is no unit. Persistence-only — never
   *  broadcast to the renderer, which keeps reading each tracker_finished. */
  | {type: 'unit_finished';    tracker: TrackerSnapshot; overlaps: UnitOverlap[]; timestamp: number; checkpoint: UnitCheckpoint}
  | {type: 'session_status';   status: 'running' | 'paused'; elapsed: number; timestamp: number}
  /** After every session write; `deleted`: the write removed it (an empty run at Stop, or Reset). */
  | {type: 'session_saved';    sessionId: string; deleted?: true}
  | {type: 'price_update';     itemId: number; price: number; timestamp: number}
  | {type: 'wealth_recorded';  timestamp: number}
  | {type: 'map_material_warning'; items: Array<{itemId: number; quantity: number}>; timestamp: number}
  | {type: 'loot_window_started'; seasonalType: TrackerSnapshot['seasonalType']; deadline: number; timestamp: number}
  | {type: 'loot_window_ended';   seasonalType: TrackerSnapshot['seasonalType']; timestamp: number}
  | {type: 'error';            message: string};
