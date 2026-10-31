import {create} from 'zustand';
import {DEFAULT_LOG_CONFIG, parseLogTargetConfig, type LogFeature, type LogTargetConfig, type LogType} from '@/shared/logging';

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

function toggle<T>(arr: T[], item: T): T[] {
  return arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item];
}

/** Main reloads the logger config itself after a `logging.*` write. */
function persist(key: string, config: LogTargetConfig): void {
  window.electronAPI.settings.set(key, JSON.stringify(config)).catch(
    (err: unknown) => console.error('[loggingStore] persist failed:', err),
  );
}

// ---------------------------------------------------------------------------
// Store definition
// ---------------------------------------------------------------------------

export const useLoggingStore = create<Store>((set, get) => ({
  console:     DEFAULT_LOG_CONFIG.console,
  file:        DEFAULT_LOG_CONFIG.file,
  logFilePath: '',
  isLoaded:    false,

  load: async () => {
    const [raw, logFilePath] = await Promise.all([
      window.electronAPI.settings.getAll(),
      window.electronAPI.logging.getLogPath(),
    ]);
    set({
      console:     parseLogTargetConfig(raw['logging.console'], DEFAULT_LOG_CONFIG.console),
      file:        parseLogTargetConfig(raw['logging.file'],    DEFAULT_LOG_CONFIG.file),
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
