import {create} from 'zustand';
import type {EngineEvent} from '@/types/electron';
import type {TrackerSnapshot} from '@/types/electron';
import {useItemsStore} from './itemsStore';

const MAX_EVENTS = 200;

export interface FeedEvent {
  id:        number;
  timestamp: number;
  event:     EngineEvent;
}

interface EngineState {
  phase:                    'idle' | 'initializing' | 'tracking';
  feed:                     FeedEvent[];
  drops:                    Record<number, number>; // itemId → net session change
  mapCount:                 number;
  currentZone:              string | null;
  mapTracker:               TrackerSnapshot | null;
  seasonalTracker:          TrackerSnapshot | null;
  mapTrackerReceivedAt:     number | null;
  seasonalTrackerReceivedAt:number | null;
  sessionStatus:            'idle' | 'running' | 'paused';
  sessionElapsed:           number;
  sessionReceivedAt:        number | null;
  /** Non-null when continuing a saved session — holds the session name. */
  activeSessionName:        string | null;
  /** ID of the last auto-saved session (used to trigger sessions list refresh). */
  lastSavedSessionId:       string | null;
}

interface EngineActions {
  init:               () => void; // register IPC listener once
  handleEvent:        (event: EngineEvent) => void;
  reset:              () => void;
  setActiveSessionName: (name: string | null) => void;
}

let _nextId = 0;
let _initialized = false;

export const useEngineStore = create<EngineState & EngineActions>((set, get) => ({
  phase:                     'idle',
  feed:                      [],
  drops:                     {},
  mapCount:                  0,
  currentZone:               null,
  mapTracker:                null,
  seasonalTracker:           null,
  mapTrackerReceivedAt:      null,
  seasonalTrackerReceivedAt: null,
  sessionStatus:             'idle',
  sessionElapsed:            0,
  sessionReceivedAt:         null,
  activeSessionName:         null,
  lastSavedSessionId:        null,

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
      let mapTracker                = s.mapTracker;
      let seasonalTracker           = s.seasonalTracker;
      let mapTrackerReceivedAt      = s.mapTrackerReceivedAt;
      let seasonalTrackerReceivedAt = s.seasonalTrackerReceivedAt;
      let sessionStatus             = s.sessionStatus;
      let sessionElapsed            = s.sessionElapsed;
      let sessionReceivedAt         = s.sessionReceivedAt;

      let activeSessionName    = s.activeSessionName;
      let lastSavedSessionId  = s.lastSavedSessionId;

      switch (event.type) {
        case 'init_started':
          phase                     = 'initializing';
          drops                     = {};
          mapCount                  = 0;
          mapTracker                = null;
          seasonalTracker           = null;
          mapTrackerReceivedAt      = null;
          seasonalTrackerReceivedAt = null;
          sessionStatus             = 'idle';
          sessionElapsed            = 0;
          sessionReceivedAt         = null;
          activeSessionName         = null;
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

        case 'tracker_started':
        case 'tracker_update':
          if (event.tracker.kind === 'map') {
            mapTracker           = event.tracker;
            mapTrackerReceivedAt = Date.now();
          } else if (event.tracker.kind === 'seasonal') {
            seasonalTracker           = event.tracker;
            seasonalTrackerReceivedAt = Date.now();
          } else if (event.tracker.kind === 'session') {
            sessionStatus     = 'running';
            sessionElapsed    = event.tracker.elapsed;
            sessionReceivedAt = Date.now();
            // On session start, seed renderer state from the snapshot so that
            // a continued session carries over its drops and map count.
            if (event.type === 'tracker_started') {
              drops    = {...event.tracker.drops};
              mapCount = event.sessionMeta?.mapCount ?? mapCount;
            }
          }
          break;

        case 'tracker_finished':
          if (event.tracker.kind === 'map') {
            mapTracker           = null;
            mapTrackerReceivedAt = null;
          } else if (event.tracker.kind === 'seasonal') {
            seasonalTracker           = null;
            seasonalTrackerReceivedAt = null;
          } else if (event.tracker.kind === 'session') {
            phase             = 'idle';
            drops             = event.tracker.drops;
            sessionStatus     = 'idle';
            sessionElapsed    = 0;
            sessionReceivedAt = null;
            activeSessionName = null;
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

        case 'price_update': {
          // DB already written by PriceHandler in main process — only sync in-memory cache
          const id       = String(event.itemId);
          const existing = useItemsStore.getState().items[id];
          if (existing) useItemsStore.setState({items: {...useItemsStore.getState().items, [id]: {...existing, price: event.price}}});
          break;
        }
      }

      return {
        feed, phase, drops, mapCount, currentZone,
        mapTracker, seasonalTracker,
        mapTrackerReceivedAt, seasonalTrackerReceivedAt,
        sessionStatus, sessionElapsed, sessionReceivedAt,
        activeSessionName, lastSavedSessionId,
      };
    });
  },

  reset: () => set({
    phase: 'idle', feed: [], drops: {}, mapCount: 0,
    currentZone: null, mapTracker: null, seasonalTracker: null,
    mapTrackerReceivedAt: null, seasonalTrackerReceivedAt: null,
    sessionStatus: 'idle', sessionElapsed: 0, sessionReceivedAt: null,
    activeSessionName: null, lastSavedSessionId: null,
  }),

  setActiveSessionName: (name) => set({activeSessionName: name}),
}));
