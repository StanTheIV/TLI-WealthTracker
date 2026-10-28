import {create} from 'zustand';
import type {EngineEnvelope, EngineSnapshot, SeasonalType, WireEngineEvent, WireTrackerSnapshot} from '@/shared/contracts/engine';

const MAX_EVENTS = 200;

export interface FeedEvent {
  id:        number;
  timestamp: number;
  event:     WireEngineEvent;
}

export interface LowStockWarning {
  itemId:   number;
  quantity: number;
}

interface EngineState {
  phase:                    'idle' | 'initializing' | 'tracking';
  feed:                     FeedEvent[];
  drops:                    Record<number, number>; // itemId → net session change
  /** The session tracker's entry-cost total (itemId → qty), replaced by every
   *  session snapshot. Never part of `drops`. */
  sessionSpent:             Record<number, number>;
  mapCount:                 number;
  currentZone:              string | null;
  mapTracker:                WireTrackerSnapshot | null;
  /** Active seasonal trackers keyed by seasonalType. Multiple can run at
   *  once (e.g. Lunaria during Overrealm). UI renders one row per entry. */
  seasonalTrackers:          Map<SeasonalType, WireTrackerSnapshot>;
  mapTrackerReceivedAt:      number | null;
  /** Per-seasonal `Date.now()` of the last tracker_started/tracker_update
   *  event — used by the elapsed-time hook to interpolate between snapshots. */
  seasonalTrackersReceivedAt:Map<SeasonalType, number>;
  sessionStatus:            'idle' | 'running' | 'paused';
  sessionElapsed:           number;
  sessionReceivedAt:        number | null;
  /** Cumulative ms spent inside maps in this session (excludes the active map). */
  accumulatedMapTime:       number;
  /** DB id of the session being tracked — set by the session tracker_started
   *  (`sessionMeta.sessionId`), cleared by the session tracker_finished. Live
   *  sessions are persisted from the start, so this row is in the sessions list. */
  activeSessionId:          string | null;
  /** The session name, only when the active session is a CONTINUED one
   *  (`sessionMeta.continued`) — the Playbar's "↩ name" badge. */
  activeSessionName:        string | null;
  /** Bumped on every session_saved (each unit write, close, delete): the
   *  sessions list and detail refetch on change. Monotonic: only the
   *  test-only `reset()` zeroes it. */
  sessionsVersion:          number;
  /** Latest low-stock map-material warnings, emitted on each map entry. */
  lowStockWarnings:         LowStockWarning[];
  /** Item IDs the user has dismissed this session — mirror of main-process set. */
  dismissedMaterials:       Set<number>;
  /** Per-seasonal deadline (ms epoch) at which that seasonal's loot
   *  collection window expires. Concurrent seasonals can each have their
   *  own loot timer, so this is keyed by SeasonalType. Updated on every
   *  loot_window_started event (initial start AND each refresh). Entries
   *  are deleted on loot_window_ended and on tracker_finished, and all of
   *  them while the session is paused: a frozen window has no countdown —
   *  resume republishes it with the remaining time. */
  lootWindowDeadlines:      Map<SeasonalType, number>;
  /** The seq of the last applied snapshot or broadcast envelope: `init`
   *  drops every envelope at or below it. */
  lastSeq:                  number;
}

interface EngineActions {
  /** Catch up with the engine, then follow it: subscribe, buffer envelopes
   *  until the snapshot (`engine.getState`) resolves, apply it, then apply the
   *  buffered and every later envelope with `seq > lastSeq`. Idempotent — every
   *  call returns the first call's promise, settled once the snapshot is in. */
  init:                 () => Promise<void>;
  /** Apply one live event (feed included). */
  handleEvent:          (event: WireEngineEvent) => void;
  /** Rebuild the store from a snapshot: every engine field back to its
   *  initial value, then each replay event reduced in order. The feed stays
   *  empty — history is not reconstructible. `sessionsVersion` is kept: it is
   *  a monotonic change counter, not engine state. */
  applySnapshot:        (snapshot: EngineSnapshot) => void;
  reset:                () => void;
  dismissLowStockItem:  (itemId: number) => void;
}

export type RunStatus = 'idle' | 'initializing' | 'running' | 'paused';

/** The run status every view shows — derived, never stored. Tracking with no
 *  session yet (init_complete → session tracker_started) is still initializing. */
export function selectRunStatus(s: Pick<EngineState, 'phase' | 'sessionStatus'>): RunStatus {
  if (s.phase === 'idle') return 'idle';
  if (s.phase === 'initializing' || s.sessionStatus === 'idle') return 'initializing';
  return s.sessionStatus;
}

function initialState(): EngineState {
  return {
    phase:                      'idle',
    feed:                       [],
    drops:                      {},
    sessionSpent:               {},
    mapCount:                   0,
    currentZone:                null,
    mapTracker:                 null,
    seasonalTrackers:           new Map<SeasonalType, WireTrackerSnapshot>(),
    mapTrackerReceivedAt:       null,
    seasonalTrackersReceivedAt: new Map<SeasonalType, number>(),
    sessionStatus:              'idle',
    sessionElapsed:             0,
    sessionReceivedAt:          null,
    accumulatedMapTime:         0,
    activeSessionId:            null,
    activeSessionName:          null,
    sessionsVersion:            0,
    lowStockWarnings:           [],
    dismissedMaterials:         new Set<number>(),
    lootWindowDeadlines:        new Map<SeasonalType, number>(),
    lastSeq:                    0,
  };
}

/** The state after `event` — everything but the feed, which only live events
 *  extend. No side effects beyond reading the clock for `*ReceivedAt`. */
function reduce(s: EngineState, event: WireEngineEvent): EngineState {
  let phase                      = s.phase;
  let drops                      = s.drops;
  let sessionSpent               = s.sessionSpent;
  let mapCount                   = s.mapCount;
  let currentZone                = s.currentZone;
  let mapTracker                 = s.mapTracker;
  let seasonalTrackers           = s.seasonalTrackers;
  let mapTrackerReceivedAt       = s.mapTrackerReceivedAt;
  let seasonalTrackersReceivedAt = s.seasonalTrackersReceivedAt;
  let sessionStatus              = s.sessionStatus;
  let sessionElapsed             = s.sessionElapsed;
  let sessionReceivedAt          = s.sessionReceivedAt;

  let activeSessionId      = s.activeSessionId;
  let activeSessionName    = s.activeSessionName;
  let sessionsVersion      = s.sessionsVersion;
  let lowStockWarnings     = s.lowStockWarnings;
  let dismissedMaterials   = s.dismissedMaterials;
  let accumulatedMapTime   = s.accumulatedMapTime;
  let lootWindowDeadlines  = s.lootWindowDeadlines;

  // The run is over: the session's tracker_finished and engine_stopped
  // clear the same state. The drops are kept. A stop drops a live map /
  // seasonals without finishing them, so their rows go here.
  const endRun = () => {
    phase                      = 'idle';
    mapTracker                 = null;
    mapTrackerReceivedAt       = null;
    seasonalTrackers           = new Map();
    seasonalTrackersReceivedAt = new Map();
    lootWindowDeadlines        = new Map();
    sessionStatus      = 'idle';
    sessionElapsed     = 0;
    sessionReceivedAt  = null;
    accumulatedMapTime = 0;
    activeSessionId    = null;
    activeSessionName  = null;
  };

  // The session pause freezes every loot window (the engine keeps the
  // remaining time): no countdown shows until resume republishes it.
  const hideFrozenWindows = () => {
    if (lootWindowDeadlines.size > 0) lootWindowDeadlines = new Map();
  };

  switch (event.type) {
    case 'init_started':
      phase                      = 'initializing';
      drops                      = {};
      sessionSpent               = {};
      mapCount                   = 0;
      mapTracker                 = null;
      seasonalTrackers           = new Map();
      mapTrackerReceivedAt       = null;
      seasonalTrackersReceivedAt = new Map();
      sessionStatus              = 'idle';
      sessionElapsed             = 0;
      sessionReceivedAt          = null;
      accumulatedMapTime         = 0;
      lowStockWarnings           = [];
      dismissedMaterials         = new Set<number>();
      lootWindowDeadlines        = new Map();
      break;

    case 'init_complete':
      phase = 'tracking';
      break;

    case 'drop':
      drops = {...drops, [event.itemId]: (drops[event.itemId] ?? 0) + event.change};
      break;

    case 'zone_change':
      currentZone = event.to;
      break;

    case 'map_started':
      mapCount = event.mapCount;
      break;

    case 'map_ended':
      accumulatedMapTime += event.elapsed;
      break;

    case 'tracker_started':
    case 'tracker_update':
      if (event.tracker.kind === 'map') {
        mapTracker           = event.tracker;
        mapTrackerReceivedAt = Date.now();
      } else if (event.tracker.kind === 'seasonal' && event.tracker.seasonalType) {
        const type = event.tracker.seasonalType;
        seasonalTrackers           = new Map(seasonalTrackers).set(type, event.tracker);
        seasonalTrackersReceivedAt = new Map(seasonalTrackersReceivedAt).set(type, Date.now());
      } else if (event.tracker.kind === 'session') {
        // `active` is false while paused: a drop accepted mid-pause
        // re-emits the snapshot and must not flip the run back to running.
        sessionStatus     = event.tracker.active ? 'running' : 'paused';
        sessionElapsed    = event.tracker.elapsed;
        sessionReceivedAt = Date.now();
        sessionSpent      = event.tracker.spent ?? {};
        if (!event.tracker.active) hideFrozenWindows();
        // On session start, seed renderer state from the snapshot so that
        // a continued session carries over its drops, map count, and
        // accumulated map time. Also fires on Engine.reset() so the
        // average-per-map metric resets correctly.
        if (event.type === 'tracker_started') {
          drops              = {...event.tracker.drops};
          mapCount           = event.sessionMeta?.mapCount ?? mapCount;
          accumulatedMapTime = event.sessionMeta?.mapTime  ?? accumulatedMapTime;
          if (event.sessionMeta) {
            activeSessionId   = event.sessionMeta.sessionId;
            activeSessionName = event.sessionMeta.continued ? event.sessionMeta.name : null;
          }
        }
      }
      break;

    case 'tracker_finished':
      if (event.tracker.kind === 'map') {
        mapTracker           = null;
        mapTrackerReceivedAt = null;
      } else if (event.tracker.kind === 'seasonal' && event.tracker.seasonalType) {
        const type = event.tracker.seasonalType;
        const nextSeasonalTrackers = new Map(seasonalTrackers); nextSeasonalTrackers.delete(type);
        const nextReceivedAt       = new Map(seasonalTrackersReceivedAt); nextReceivedAt.delete(type);
        const nextDeadlines        = new Map(lootWindowDeadlines); nextDeadlines.delete(type);
        seasonalTrackers           = nextSeasonalTrackers;
        seasonalTrackersReceivedAt = nextReceivedAt;
        lootWindowDeadlines        = nextDeadlines;
      } else if (event.tracker.kind === 'session') {
        drops        = event.tracker.drops;
        sessionSpent = event.tracker.spent ?? {};
        endRun();
      }
      break;

    case 'engine_stopped':
      // Every stop ends with this — also one during bag init, which has no
      // session to finish. The drops stay on screen until the next run.
      endRun();
      break;

    case 'session_status':
      sessionStatus     = event.status;
      sessionElapsed    = event.elapsed;
      sessionReceivedAt = Date.now();
      if (event.status === 'paused') hideFrozenWindows();
      break;

    case 'session_saved':
      sessionsVersion += 1;
      break;

    case 'map_material_warning':
      // The engine is authoritative: its emitted list already excludes
      // dismissed items. The local dismissedMaterials set is only used
      // to hide a row optimistically between a click-dismiss and the
      // next map entry. Reset it on each event so we trust the engine.
      lowStockWarnings   = event.items;
      dismissedMaterials = new Set<number>();
      break;

    case 'loot_window_started':
      if (event.seasonalType) {
        lootWindowDeadlines = new Map(lootWindowDeadlines).set(event.seasonalType, event.deadline);
      }
      break;

    case 'loot_window_ended':
      if (event.seasonalType) {
        const next = new Map(lootWindowDeadlines);
        next.delete(event.seasonalType);
        lootWindowDeadlines = next;
      }
      break;

    // new_item: feed only — the item row itself arrives on
    // items:changed, which itemsStore subscribes to directly.
  }

  return {
    ...s,
    phase, drops, sessionSpent, mapCount, currentZone,
    mapTracker, seasonalTrackers,
    mapTrackerReceivedAt, seasonalTrackersReceivedAt,
    sessionStatus, sessionElapsed, sessionReceivedAt,
    accumulatedMapTime,
    activeSessionId, activeSessionName, sessionsVersion,
    lowStockWarnings, dismissedMaterials,
    lootWindowDeadlines,
  };
}

let _nextId = 0;
/** The first `init()`'s promise — one subscription, one snapshot per window. */
let _init: Promise<void> | null = null;

/** `event` reduced live: the state change plus its feed entry. */
function applyLive(s: EngineState, event: WireEngineEvent): EngineState {
  const feedEntry: FeedEvent = {id: _nextId++, timestamp: Date.now(), event};
  return {...reduce(s, event), feed: [...s.feed, feedEntry].slice(-MAX_EVENTS)};
}

export const useEngineStore = create<EngineState & EngineActions>((set, get) => ({
  ...initialState(),

  init: () => {
    if (_init) return _init;
    // Subscribed before the snapshot is asked for, so nothing broadcast in
    // between is lost: until it lands, envelopes wait here.
    let buffered: EngineEnvelope[] | null = [];
    const apply = ({seq, event}: EngineEnvelope) => {
      if (seq <= get().lastSeq) return; // already in the snapshot, or a re-delivery
      set(s => ({...applyLive(s, event), lastSeq: seq}));
    };
    window.electronAPI.engine.onEvent(envelope => {
      if (buffered) buffered.push(envelope);
      else          apply(envelope);
    });
    _init = window.electronAPI.engine.getState()
      .then(snapshot => get().applySnapshot(snapshot))
      .finally(() => {
        // Even when the snapshot failed: from here on, envelopes apply live.
        const pending = buffered ?? [];
        buffered = null;
        for (const envelope of pending) apply(envelope);
      });
    return _init;
  },

  handleEvent: (event) => set(s => applyLive(s, event)),

  applySnapshot: ({seq, events}) => set(s => {
    let next: EngineState = {...initialState(), sessionsVersion: s.sessionsVersion};
    for (const event of events) next = reduce(next, event);
    return {...next, lastSeq: seq};
  }),

  reset: () => set(initialState()),

  dismissLowStockItem: (itemId) => {
    window.electronAPI.engine.dismissMaterial(itemId);
    set(s => {
      const next = new Set(s.dismissedMaterials);
      next.add(itemId);
      return {dismissedMaterials: next};
    });
  },
}));
