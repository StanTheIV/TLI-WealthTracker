import {create} from 'zustand';
import type {EngineEvent, SeasonalType} from '@/types/electron';
import type {TrackerSnapshot} from '@/types/electron';
import {useItemsStore} from './itemsStore';

const MAX_EVENTS = 200;

export interface FeedEvent {
  id:        number;
  timestamp: number;
  event:     EngineEvent;
}

export interface LowStockWarning {
  itemId:   number;
  quantity: number;
}

interface EngineState {
  phase:                    'idle' | 'initializing' | 'tracking';
  feed:                     FeedEvent[];
  drops:                    Record<number, number>; // itemId → net session change
  mapCount:                 number;
  currentZone:              string | null;
  mapTracker:                TrackerSnapshot | null;
  /** Active seasonal trackers keyed by seasonalType. Multiple can run at
   *  once (e.g. Lunaria during Overrealm). UI renders one row per entry. */
  seasonalTrackers:          Map<SeasonalType, TrackerSnapshot>;
  mapTrackerReceivedAt:      number | null;
  /** Per-seasonal `Date.now()` of the last tracker_started/tracker_update
   *  event — used by the elapsed-time hook to interpolate between snapshots. */
  seasonalTrackersReceivedAt:Map<SeasonalType, number>;
  sessionStatus:            'idle' | 'running' | 'paused';
  sessionElapsed:           number;
  sessionReceivedAt:        number | null;
  /** Cumulative ms spent inside maps in this session (excludes the active map). */
  accumulatedMapTime:       number;
  /** Non-null when continuing a saved session — holds the session name. */
  activeSessionName:        string | null;
  /** ID of the last auto-saved session (used to trigger sessions list refresh). */
  lastSavedSessionId:       string | null;
  /** Latest low-stock map-material warnings, emitted on each map entry. */
  lowStockWarnings:         LowStockWarning[];
  /** Item IDs the user has dismissed this session — mirror of main-process set. */
  dismissedMaterials:       Set<number>;
  /** Per-seasonal deadline (ms epoch) at which that seasonal's loot
   *  collection window expires. Concurrent seasonals can each have their
   *  own loot timer, so this is keyed by SeasonalType. Updated on every
   *  loot_window_started event (initial start AND each refresh). Entries
   *  are deleted on loot_window_ended and on tracker_finished. */
  lootWindowDeadlines:      Map<SeasonalType, number>;
}

interface EngineActions {
  init:                 () => void; // register IPC listener once
  handleEvent:          (event: EngineEvent) => void;
  reset:                () => void;
  setActiveSessionName: (name: string | null) => void;
  dismissLowStockItem:  (itemId: number) => void;
}

let _nextId = 0;
let _initialized = false;

export const useEngineStore = create<EngineState & EngineActions>((set, get) => ({
  phase:                     'idle',
  feed:                      [],
  drops:                     {},
  mapCount:                  0,
  currentZone:               null,
  mapTracker:                 null,
  seasonalTrackers:           new Map<SeasonalType, TrackerSnapshot>(),
  mapTrackerReceivedAt:       null,
  seasonalTrackersReceivedAt: new Map<SeasonalType, number>(),
  sessionStatus:             'idle',
  sessionElapsed:            0,
  sessionReceivedAt:         null,
  accumulatedMapTime:        0,
  activeSessionName:         null,
  lastSavedSessionId:        null,
  lowStockWarnings:          [],
  dismissedMaterials:        new Set<number>(),
  lootWindowDeadlines:       new Map<SeasonalType, number>(),

  init: () => {
    if (_initialized) return;
    _initialized = true;
    window.electronAPI.engine.onEvent((event) => get().handleEvent(event));
  },

  handleEvent: (event) => {
    const feedEntry: FeedEvent = {id: _nextId++, timestamp: Date.now(), event};

    set(s => {
      const feed = [...s.feed, feedEntry].slice(-MAX_EVENTS);
      let phase                     = s.phase;
      let drops                     = s.drops;
      let mapCount                  = s.mapCount;
      let currentZone               = s.currentZone;
      let mapTracker                 = s.mapTracker;
      let seasonalTrackers           = s.seasonalTrackers;
      let mapTrackerReceivedAt       = s.mapTrackerReceivedAt;
      let seasonalTrackersReceivedAt = s.seasonalTrackersReceivedAt;
      let sessionStatus              = s.sessionStatus;
      let sessionElapsed             = s.sessionElapsed;
      let sessionReceivedAt          = s.sessionReceivedAt;

      let activeSessionName    = s.activeSessionName;
      let lastSavedSessionId  = s.lastSavedSessionId;
      let lowStockWarnings     = s.lowStockWarnings;
      let dismissedMaterials   = s.dismissedMaterials;
      let accumulatedMapTime   = s.accumulatedMapTime;
      let lootWindowDeadlines  = s.lootWindowDeadlines;

      switch (event.type) {
        case 'init_started':
          phase                      = 'initializing';
          drops                      = {};
          mapCount                   = 0;
          mapTracker                 = null;
          seasonalTrackers           = new Map();
          mapTrackerReceivedAt       = null;
          seasonalTrackersReceivedAt = new Map();
          sessionStatus              = 'idle';
          sessionElapsed             = 0;
          sessionReceivedAt          = null;
          accumulatedMapTime         = 0;
          activeSessionName          = null;
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

        case 'new_item': {
          const id = String(event.itemId);
          const itemsState = useItemsStore.getState();
          if (!itemsState.items[id]) {
            useItemsStore.setState({
              items: {...itemsState.items, [id]: {id, name: '', type: 'other', price: 0, priceDate: 0}},
            });
          }
          break;
        }

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
            sessionStatus     = 'running';
            sessionElapsed    = event.tracker.elapsed;
            sessionReceivedAt = Date.now();
            // On session start, seed renderer state from the snapshot so that
            // a continued session carries over its drops, map count, and
            // accumulated map time. Also fires on Engine.reset() so the
            // average-per-map metric resets correctly.
            if (event.type === 'tracker_started') {
              drops              = {...event.tracker.drops};
              mapCount           = event.sessionMeta?.mapCount ?? mapCount;
              accumulatedMapTime = event.sessionMeta?.mapTime  ?? accumulatedMapTime;
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
            phase              = 'idle';
            drops              = event.tracker.drops;
            sessionStatus      = 'idle';
            sessionElapsed     = 0;
            sessionReceivedAt  = null;
            accumulatedMapTime = 0;
            activeSessionName  = null;
          }
          break;

        case 'session_status':
          sessionStatus     = event.status;
          sessionElapsed    = event.elapsed;
          sessionReceivedAt = Date.now();
          break;

        case 'session_saved':
          lastSavedSessionId = event.sessionId;
          break;

        case 'price_update':
          // The main process now broadcasts price changes via items:changed,
          // which itemsStore subscribes to directly. No work needed here.
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
      }

      return {
        feed, phase, drops, mapCount, currentZone,
        mapTracker, seasonalTrackers,
        mapTrackerReceivedAt, seasonalTrackersReceivedAt,
        sessionStatus, sessionElapsed, sessionReceivedAt,
        accumulatedMapTime,
        activeSessionName, lastSavedSessionId,
        lowStockWarnings, dismissedMaterials,
        lootWindowDeadlines,
      };
    });
  },

  reset: () => set({
    phase: 'idle', feed: [], drops: {}, mapCount: 0,
    currentZone: null, mapTracker: null,
    seasonalTrackers: new Map(),
    mapTrackerReceivedAt: null,
    seasonalTrackersReceivedAt: new Map(),
    sessionStatus: 'idle', sessionElapsed: 0, sessionReceivedAt: null,
    accumulatedMapTime: 0,
    activeSessionName: null, lastSavedSessionId: null,
    lowStockWarnings: [], dismissedMaterials: new Set<number>(),
    lootWindowDeadlines: new Map(),
  }),

  setActiveSessionName: (name) => set({activeSessionName: name}),

  dismissLowStockItem: (itemId) => {
    window.electronAPI.engine.dismissMaterial(itemId);
    set(s => {
      const next = new Set(s.dismissedMaterials);
      next.add(itemId);
      return {dismissedMaterials: next};
    });
  },
}));
