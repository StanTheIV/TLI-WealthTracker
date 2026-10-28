import type {FilterRule} from '../item-filter';
import type {
  DbItem,
  DbItemFilter,
  DbSession,
  DbSessionMap,
  DbWealthDatapoint,
  ItemChangedPatch,
  PriceBucket,
  PriceExportRow,
  PriceMover,
} from './db';
import type {EngineEvent} from './engine';
import type {League} from './leagues';

export interface UpdateInfo {
  version:     string;
  changelog:   string;
  downloadUrl: string;
}

/** The bridge the preload script exposes to every renderer as `window.electronAPI`. */
export interface ElectronAPI {
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
    start:           () => void;
    /** Continue a saved session; rejects when it can't be continued (missing, not drop-through, active). */
    startWithSession:(sessionId: string) => Promise<void>;
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
    setSandlordWaveMs:    (ms: number) => void;
    setHuntingLootMs:     (ms: number) => void;
    setAfterlightLootMs:  (ms: number) => void;
    onEvent:         (cb: (event: EngineEvent) => void) => () => void;
  };

  overlay: {
    show:           () => void;
    hide:           () => void;
    setClickThrough:(enabled: boolean) => void;
    setSize:        (w: number, h: number) => void;
    notifyReady:    () => void;
    moveBy:         (dx: number, dy: number) => void;
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
      delete:  (id: string) => Promise<void>;
      rename:  (id: string, name: string) => Promise<void>;
    };
    sessionMaps: {
      getForSession: (sessionId: string) => Promise<DbSessionMap[]>;
    };
    wealth: {
      getRange:  (from: number, to: number) => Promise<DbWealthDatapoint[]>;
      getLatest: (limit: number) => Promise<DbWealthDatapoint[]>;
      delete:    (id: number) => Promise<void>;
      clear:     () => Promise<void>;
    };
    filters: {
      getAll:     () => Promise<DbItemFilter[]>;
      insert:     (filter: DbItemFilter) => Promise<void>;
      update:     (filter: DbItemFilter) => Promise<void>;
      delete:     (id: string) => Promise<void>;
      setEnabled: (id: string, enabled: boolean) => Promise<void>;
    };
    leagues: {
      getAll:    () => Promise<League[]>;
      startNow:  (name?: string) => Promise<League>;
      /** User leagues only; resolves false for official rows. */
      setStart:  (id: string, ts: number) => Promise<boolean>;
      onChanged: (cb: () => void) => () => void;
    };
    prices: {
      /** Bucketed history over [from, to). */
      history: (itemId: string, from: number, to: number) => Promise<PriceBucket[]>;
      movers:  (from: number, to: number) => Promise<PriceMover[]>;
      export:  (from: number, to: number) => Promise<PriceExportRow[]>;
    };
  };
}
