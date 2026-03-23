import {create} from 'zustand';

// ---------------------------------------------------------------------------
// Types (mirrored from main/logger.ts — renderer can't import main-process code)
// ---------------------------------------------------------------------------

export type LogFeature =
  | 'engine' | 'worker' | 'database' | 'ipc' | 'overlay'
  | 'session' | 'price' | 'wealth' | 'app' | 'filter';

export type LogType = 'info' | 'warn' | 'error' | 'debug';

export interface LogTargetConfig {
  enabled:  boolean;
  features: LogFeature[];
  types:    LogType[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const ALL_FEATURES: LogFeature[] = [
  'engine', 'worker', 'database', 'ipc', 'overlay',
  'session', 'price', 'wealth', 'app', 'filter',
];

const DEFAULT_TYPES: LogType[] = ['info', 'warn', 'error'];

const DEFAULT_CONSOLE: LogTargetConfig = {enabled: true,  features: ALL_FEATURES, types: DEFAULT_TYPES};
const DEFAULT_FILE:    LogTargetConfig = {enabled: false, features: ALL_FEATURES, types: DEFAULT_TYPES};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface LoggingState {
  console:     LogTargetConfig;
  file:        LogTargetConfig;
  logFilePath: string;
  isLoaded:    boolean;
}

interface LoggingActions {
  load:                () => Promise<void>;
  setConsoleEnabled:   (enabled: boolean) => void;
  setFileEnabled:      (enabled: boolean) => void;
  toggleConsoleFeature:(feature: LogFeature) => void;
  toggleConsoleType:   (type: LogType) => void;
  toggleFileFeature:   (feature: LogFeature) => void;
  toggleFileType:      (type: LogType) => void;
}

type Store = LoggingState & LoggingActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseConfig(raw: string | undefined, fallback: LogTargetConfig): LogTargetConfig {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<LogTargetConfig>;
    return {
      enabled:  typeof parsed.enabled === 'boolean' ? parsed.enabled : fallback.enabled,
      features: Array.isArray(parsed.features) ? parsed.features as LogFeature[] : fallback.features,
      types:    Array.isArray(parsed.types)    ? parsed.types    as LogType[]    : fallback.types,
    };
  } catch {
    return fallback;
  }
}

function toggle<T>(arr: T[], item: T): T[] {
  return arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item];
}

async function persist(key: string, config: LogTargetConfig): Promise<void> {
  await window.electronAPI.db.settings.set(key, JSON.stringify(config)).catch(
    (err: unknown) => console.error('[loggingStore] persist failed:', err),
  );
  await window.electronAPI.logging.reloadConfig();
}

// ---------------------------------------------------------------------------
// Store definition
// ---------------------------------------------------------------------------

export const useLoggingStore = create<Store>((set, get) => ({
  console:     DEFAULT_CONSOLE,
  file:        DEFAULT_FILE,
  logFilePath: '',
  isLoaded:    false,

  load: async () => {
    const [raw, logFilePath] = await Promise.all([
      window.electronAPI.db.settings.getAll(),
      window.electronAPI.logging.getLogPath(),
    ]);
    set({
      console:     parseConfig(raw['logging.console'], DEFAULT_CONSOLE),
      file:        parseConfig(raw['logging.file'],    DEFAULT_FILE),
      logFilePath,
      isLoaded: true,
    });
  },

  setConsoleEnabled: (enabled) => {
    const next = {...get().console, enabled};
    set({console: next});
    persist('logging.console', next);
  },

  setFileEnabled: (enabled) => {
    const next = {...get().file, enabled};
    set({file: next});
    persist('logging.file', next);
  },

  toggleConsoleFeature: (feature) => {
    const next = {...get().console, features: toggle(get().console.features, feature)};
    set({console: next});
    persist('logging.console', next);
  },

  toggleConsoleType: (type) => {
    const next = {...get().console, types: toggle(get().console.types, type)};
    set({console: next});
    persist('logging.console', next);
  },

  toggleFileFeature: (feature) => {
    const next = {...get().file, features: toggle(get().file.features, feature)};
    set({file: next});
    persist('logging.file', next);
  },

  toggleFileType: (type) => {
    const next = {...get().file, types: toggle(get().file.types, type)};
    set({file: next});
    persist('logging.file', next);
  },
}));
