import type {FilterRule} from '../item-filter';
import type {Settings} from '../settings';
import type {
  DbItem,
  DbItemFilter,
  DbSession,
  DbSessionMap,
  ItemChangedPatch,
  PriceBucket,
  PriceExportRow,
  PriceMover,
} from './db';
import type {EngineEnvelope, EngineSnapshot} from './engine';
import type {League} from './leagues';
import type {WealthLatestBreakdown, WealthSeriesPoint} from './wealth';

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
    getLogPath: () => Promise<string>;
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
    dismissMaterial: (itemId: number) => void;
    /** The engine's replay as of a broadcast seq — apply it, then only `onEvent` envelopes with a later seq. */
    getState:        () => Promise<EngineSnapshot>;
    onEvent:         (cb: (envelope: EngineEnvelope) => void) => () => void;
  };

  overlay: {
    show:           () => void;
    hide:           () => void;
    setClickThrough:(enabled: boolean) => void;
    setSize:        (w: number, h: number) => void;
    notifyReady:    () => void;
    /** Shifts the overlay during a drag; nothing is persisted. */
    moveBy:         (dx: number, dy: number) => void;
    /** Ends a drag that moved: main persists the overlay's current position. */
    dragEnd:        () => void;
  };

  /** Every renderer settings write goes through `set` (main persists, applies
   *  its side effect, then pushes the parsed table to both windows). */
  settings: {
    /** The raw settings table. */
    getAll:    () => Promise<Record<string, string>>;
    /** Rejects when the write fails to persist. */
    set:       (key: string, value: string) => Promise<void>;
    onChanged: (cb: (settings: Settings) => void) => () => void;
  };

  db: {
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
      /** The readings in [from, to] as displayed (valued in main), timestamp order. */
      series:    (from: number, to: number) => Promise<WealthSeriesPoint[]>;
      /** The latest reading with its Item Breakdown rows; null with none. */
      latestBreakdown: () => Promise<WealthLatestBreakdown | null>;
      delete:    (id: number) => Promise<void>;
      clear:     () => Promise<void>;
      /** The displayed values changed without a new reading (filter, item
       *  type, tax setting, delete, clear): re-fetch. A new reading arrives as
       *  `wealth_recorded` instead. */
      onChanged: (cb: () => void) => () => void;
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
