import type {FilterRule} from './itemFilter';

export {};

export type SeasonalType = 'vorex' | 'dream' | 'overrealm' | 'carjack' | 'clockwork' | 'sandlord' | 'lunaria';
/** A drop's attribution source for the per-source breakdown pie. 'map' covers
 *  drops where no seasonal was the writer; the SeasonalType variants cover
 *  drops where that seasonal was the newest active tracker. */
export type Source = 'map' | SeasonalType;

export interface TrackerSnapshot {
  kind:          'session' | 'map' | 'seasonal';
  drops:         Record<number, number>;
  elapsed:       number;
  seasonalType?: SeasonalType;
  /** False while the tracker is paused (e.g. Lunaria between strum episodes —
   *  drops won't accrue but the tracker isn't finished). */
  active:        boolean;
  /** Per-source breakdown — populated only on the session tracker's snapshot.
   *  Each drop is attributed to exactly one source (newest active tracker at
   *  the moment the drop fired). Slices sum to session FE. Omitted on map and
   *  seasonal tracker snapshots to keep them small. */
  dropsBySource?: Record<Source, Record<number, number>>;
}

export interface UpdateInfo {
  version:     string;
  changelog:   string;
  downloadUrl: string;
}

export interface DbItem {
  id:        string;
  name:      string;
  type:      string;
  price:     number;
  priceDate: number;
  /** Local-only flag: when true, automated price scrapes from the worker skip
   *  this item. Manual edits in the UI still go through. Excluded from
   *  full_table.json import/export. */
  locked?:   boolean;
}

/** Broadcast on every item mutation in the main process so all renderer windows
 *  keep their itemsStore copies in sync. `changes` is a partial DbItem patch. */
export interface ItemChangedPatch {
  id:      string;
  changes: Partial<Omit<DbItem, 'id'>>;
}

export interface DbSession {
  id:            string;
  name:          string;
  savedAt:       string;
  totalTime:     number;
  mapTime:       number;
  mapCount:      number;
  drops:         Record<string, number>;
  /** Per-source attribution for the source-breakdown pie. Each itemId qty
   *  appears under exactly one source (newest active tracker at write time),
   *  so summing per-source totals reproduces session FE. Empty `{}` for
   *  legacy sessions saved before this column existed — pie falls back to
   *  per-map-row aggregation in that case. */
  dropsBySource: Record<Source, Record<string, number>>;
}

/** Per-run breakdown row for a saved session. Written by the engine on every
 *  map exit, on standalone seasonal runs (e.g. Sandlord) that have no
 *  enclosing map, AND on seasonal runs that overlap a regular map (Overrealm,
 *  Clockwork, etc.). Flushed to disk alongside the session's own row. */
export interface DbSessionMap {
  sessionId:    string;
  mapIndex:     number;
  startedAt:    number;        // ms epoch
  duration:     number;        // ms
  drops:        Record<string, number>;
  spent:        Record<string, number>;
  /** Non-null for seasonal rows (standalone OR overlap); null for plain map rows. */
  seasonalType: SeasonalType | null;
  /** Non-null only for overlap seasonal rows — points at the `mapIndex` of the
   *  parent map row whose drops also include this seasonal's drops. Null for
   *  primary rows (regular maps and standalone seasonals). Sum-across-rows
   *  aggregations must filter by `parentMapIndex == null` to avoid double-counting. */
  parentMapIndex: number | null;
}

export interface DbSeasonalStat {
  zoneType:    string;
  zoneCount:   number;
  totalTime:   number;
  totalIncome: number;
  dropList:    Record<string, number>;
}

export interface DbWealthDatapoint {
  timestamp: number;
  value:     number;
  sessionId: string | null;
  breakdown: string; // JSON: Record<itemId, {qty: number; price: number; total: number}>
}

export interface DbItemFilter {
  id:      string;
  name:    string;
  enabled: boolean;
  rules:   string; // JSON FilterRule[]
}

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
  | {type: 'session_status';   status: 'running' | 'paused'; elapsed: number; timestamp: number}
  | {type: 'session_saved';    sessionId: string}
  | {type: 'price_update';     itemId: number; price: number; timestamp: number}
  | {type: 'wealth_recorded';  timestamp: number}
  | {type: 'map_material_warning'; items: Array<{itemId: number; quantity: number}>; timestamp: number}
  | {type: 'loot_window_started'; seasonalType: TrackerSnapshot['seasonalType']; deadline: number; timestamp: number}
  | {type: 'loot_window_ended';   seasonalType: TrackerSnapshot['seasonalType']; timestamp: number}
  | {type: 'error';            message: string};

interface ElectronAPI {
  pickFolder:   () => Promise<string | null>;
  checkLogFile: (folder: string) => Promise<boolean>;

  logging: {
    reloadConfig: () => Promise<void>;
    getLogPath:   () => Promise<string>;
  };

  updater: {
    check:            () => Promise<UpdateInfo | null>;
    download:         () => Promise<{success: boolean; path?: string; error?: string}>;
    install:          (path: string) => void;
    getChangelog:     () => Promise<{version: string; changelog: string} | null>;
    dismissChangelog: () => Promise<void>;
    onProgress:       (cb: (pct: number) => void) => () => void;
  };

  engine: {
    start:           (logPath: string) => void;
    startWithSession:(logPath: string, sessionId: string) => void;
    stop:            () => void;
    pause:           () => void;
    resume:          () => void;
    reset:           () => void;
    updateFilterRules: (rules: FilterRule[] | null) => void;
    dismissMaterial:      (itemId: number) => void;
    setLowStockThreshold: (n: number) => void;
    setOverrealmLootMs:   (ms: number) => void;
    setCarjackLootMs:     (ms: number) => void;
    setClockworkLootMs:   (ms: number) => void;
    setLunariaLootMs:     (ms: number) => void;
    onEvent:         (cb: (event: EngineEvent) => void) => () => void;
  };

  overlay: {
    show:           () => void;
    hide:           () => void;
    setClickThrough:(enabled: boolean) => void;
    setPosition:    (x: number, y: number) => void;
    setSize:        (w: number, h: number) => void;
    notifyReady:    () => void;
    moveBy:         (dx: number, dy: number) => void;
    getPosition:    () => Promise<{x: number; y: number}>;
    setOpacity:       (v: number) => void;
    onOpacity:        (cb: (v: number) => void) => () => void;
    broadcastSetting: (key: string, value: string) => void;
    onSettingChange:  (cb: (key: string, value: string) => void) => () => void;
  };

  db: {
    settings: {
      getAll: () => Promise<Record<string, string>>;
      set:    (key: string, value: string) => Promise<void>;
    };
    items: {
      getAll:     () => Promise<DbItem[]>;
      upsert:     (item: DbItem) => Promise<void>;
      setName:    (id: string, name: string) => Promise<void>;
      setType:    (id: string, type: string) => Promise<void>;
      setPrice:   (id: string, price: number) => Promise<void>;
      setLocked:  (id: string, locked: boolean) => Promise<void>;
      lookupName:  (id: string) => Promise<{name: string | null; type: string | null; lookupsToday: number} | {error: string; lookupsToday: number}>;
      importBatch: (items: DbItem[]) => Promise<number>;
      onChanged:   (cb: (patch: ItemChangedPatch) => void) => () => void;
    };
    lookups: {
      getToday: () => Promise<number>;
    };
    sessions: {
      getAll:  () => Promise<DbSession[]>;
      insert:  (session: DbSession) => Promise<void>;
      update:  (session: DbSession) => Promise<void>;
      delete:  (id: string) => Promise<void>;
      rename:  (id: string, name: string) => Promise<void>;
      getOne:  (id: string) => Promise<DbSession | null>;
    };
    sessionMaps: {
      getForSession: (sessionId: string) => Promise<DbSessionMap[]>;
    };
    seasonal: {
      getAll:  () => Promise<DbSeasonalStat[]>;
      upsert:  (stat: DbSeasonalStat) => Promise<void>;
    };
    wealth: {
      insert:    (point: DbWealthDatapoint) => Promise<void>;
      getRange:  (from: number, to: number) => Promise<DbWealthDatapoint[]>;
      getLatest: (limit: number) => Promise<DbWealthDatapoint[]>;
      clear:     () => Promise<void>;
    };
    filters: {
      getAll:     () => Promise<DbItemFilter[]>;
      insert:     (filter: DbItemFilter) => Promise<void>;
      update:     (filter: DbItemFilter) => Promise<void>;
      delete:     (id: string) => Promise<void>;
      setEnabled: (id: string, enabled: boolean) => Promise<void>;
    };
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
