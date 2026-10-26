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
  elapsed:       number;
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
  | {type: 'tracker_started';  tracker: TrackerSnapshot; timestamp: number; sessionMeta?: {mapTime: number; mapCount: number}}
  | {type: 'tracker_update';   tracker: TrackerSnapshot; timestamp: number}
  | {type: 'tracker_finished'; tracker: TrackerSnapshot; timestamp: number; sessionMeta?: {mapTime: number; mapCount: number}}
  /** The saved unit, built by the engine: a map with the seasonal runs that
   *  were its children (`overlaps`, in finish order), or a STANDALONE seasonal
   *  run (`overlaps` empty). Emitted after the primary's own tracker_finished;
   *  `timestamp` is the primary's finish time. Persistence-only — never
   *  broadcast to the renderer, which keeps reading each tracker_finished. */
  | {type: 'unit_finished';    tracker: TrackerSnapshot; overlaps: UnitOverlap[]; timestamp: number}
  | {type: 'session_status';   status: 'running' | 'paused'; elapsed: number; timestamp: number}
  | {type: 'session_saved';    sessionId: string}
  | {type: 'price_update';     itemId: number; price: number; timestamp: number}
  | {type: 'wealth_recorded';  timestamp: number}
  | {type: 'map_material_warning'; items: Array<{itemId: number; quantity: number}>; timestamp: number}
  | {type: 'loot_window_started'; seasonalType: TrackerSnapshot['seasonalType']; deadline: number; timestamp: number}
  | {type: 'loot_window_ended';   seasonalType: TrackerSnapshot['seasonalType']; timestamp: number}
  | {type: 'error';            message: string};
