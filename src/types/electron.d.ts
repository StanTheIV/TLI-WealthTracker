export {};

export interface TrackerSnapshot {
  kind:          'session' | 'map' | 'seasonal';
  drops:         Record<number, number>;
  elapsed:       number;
  seasonalType?: 'vorex' | 'dream' | 'overrealm' | 'carjack';
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
}

export interface DbSession {
  id:        string;
  name:      string;
  savedAt:   string;
  totalTime: number;
  mapTime:   number;
  mapCount:  number;
  drops:     Record<string, number>;
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
  | {type: 'zone_change';      from: string; to: string; entering: 'map' | 'town' | 'unknown'; timestamp: number}
  | {type: 'map_started';      mapCount: number; timestamp: number}
  | {type: 'map_ended';        elapsed: number; timestamp: number}
  | {type: 'tracker_started';  tracker: TrackerSnapshot; timestamp: number}
  | {type: 'tracker_update';   tracker: TrackerSnapshot; timestamp: number}
  | {type: 'tracker_finished'; tracker: TrackerSnapshot; timestamp: number; sessionMeta?: {mapTime: number; mapCount: number}}
  | {type: 'session_status';   status: 'running' | 'paused'; elapsed: number; timestamp: number}
  | {type: 'session_saved';    sessionId: string}
  | {type: 'price_update';     itemId: number; price: number; timestamp: number}
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
    updateFilterRules: (rules: unknown) => void;
    onEvent:         (cb: (event: EngineEvent) => void) => () => void;
  };

  overlay: {
    show:           () => void;
    hide:           () => void;
    setClickThrough:(enabled: boolean) => void;
    setPosition:    (x: number, y: number) => void;
    setSize:        (w: number, h: number) => void;
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
      lookupName:  (id: string) => Promise<{name: string | null; type: string | null; lookupsToday: number} | {error: string; lookupsToday: number}>;
      importBatch: (items: DbItem[]) => Promise<number>;
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
