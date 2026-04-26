import {create} from 'zustand';
import i18n from '@/i18n';

export type RateTimeframe = 'hour' | 'minute';
export type ThemeMode = 'system' | 'dark' | 'light';

interface SettingsState {
  torchlightPath:           string;
  overlayOpacity:           number;
  clickThroughWhileRunning: boolean;
  pauseTotalTimerInTown:    boolean;
  language:                 string;
  logFileValid:             boolean;
  serperApiKey:             string;
  rateTimeframe:            RateTimeframe;
  themeMode:                ThemeMode;
  lowStockThreshold:        number;
  isLoaded:                 boolean;
}

interface SettingsActions {
  load:                         () => Promise<void>;
  setTorchlightPath:            (v: string) => void;
  setOverlayOpacity:            (v: number) => void;
  setClickThroughWhileRunning:  (v: boolean) => void;
  setPauseTotalTimerInTown:     (v: boolean) => void;
  setLanguage:                  (v: string) => void;
  validateLogFile:              () => Promise<boolean>;
  setSerperApiKey:              (v: string) => void;
  setRateTimeframe:             (v: RateTimeframe) => void;
  setThemeMode:                 (v: ThemeMode) => void;
  setLowStockThreshold:         (v: number) => void;
}

const DEFAULTS: SettingsState = {
  torchlightPath:           '',
  overlayOpacity:           0.9,
  clickThroughWhileRunning: false,
  pauseTotalTimerInTown:    false,
  language:                 'en',
  logFileValid:             false,
  serperApiKey:             '',
  rateTimeframe:            'hour',
  themeMode:                'system',
  lowStockThreshold:        0,
  isLoaded:                 false,
};

function persist(key: string, value: string) {
  window.electronAPI.db.settings.set(key, value).catch(
    (err: unknown) => console.error('[settings] persist failed:', err)
  );
  // Broadcast to overlay window so it stays in sync without a full reload
  window.electronAPI.overlay.broadcastSetting(key, value);
}

type Store = SettingsState & SettingsActions;

export const useSettingsStore = create<Store>((set, get) => ({
  ...DEFAULTS,

  load: async () => {
    const raw = await window.electronAPI.db.settings.getAll();
    const language      = raw.language ?? 'en';
    const torchlightPath = raw.torchlightPath ?? '';
    i18n.changeLanguage(language);
    const logFileValid = torchlightPath
      ? await window.electronAPI.checkLogFile(torchlightPath)
      : false;
    const parsedThreshold = raw.lowStockThreshold !== undefined ? Number(raw.lowStockThreshold) : 0;
    const lowStockThreshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0
      ? Math.floor(parsedThreshold)
      : 0;
    set({
      torchlightPath,
      overlayOpacity: raw.overlayOpacity ? Number(raw.overlayOpacity) : 0.9,
      clickThroughWhileRunning: raw.clickThroughWhileRunning === 'true',
      pauseTotalTimerInTown:    raw.pauseTotalTimerInTown === 'true',
      language,
      logFileValid,
      serperApiKey: raw.serper_api_key ?? '',
      rateTimeframe: (raw.rateTimeframe === 'minute' ? 'minute' : 'hour') as RateTimeframe,
      themeMode: (['system', 'dark', 'light'].includes(raw.themeMode ?? '') ? raw.themeMode : 'system') as ThemeMode,
      lowStockThreshold,
      isLoaded: true,
    });
    window.electronAPI.engine.setLowStockThreshold(lowStockThreshold);
  },

  setTorchlightPath: (v) => {
    persist('torchlightPath', v);
    set({torchlightPath: v});
  },

  setOverlayOpacity: (v) => {
    persist('overlayOpacity', String(v));
    window.electronAPI.overlay.setOpacity(v);
    set({overlayOpacity: v});
  },

  setClickThroughWhileRunning: (v) => {
    persist('clickThroughWhileRunning', v ? 'true' : 'false');
    set({clickThroughWhileRunning: v});
  },

  setPauseTotalTimerInTown: (v) => {
    persist('pauseTotalTimerInTown', v ? 'true' : 'false');
    set({pauseTotalTimerInTown: v});
  },

  setLanguage: (v) => {
    persist('language', v);
    i18n.changeLanguage(v);
    set({language: v});
  },

  setSerperApiKey: (v) => {
    persist('serper_api_key', v);
    set({serperApiKey: v});
  },

  setRateTimeframe: (v) => {
    persist('rateTimeframe', v);
    set({rateTimeframe: v});
  },

  setThemeMode: (v) => {
    persist('themeMode', v);
    set({themeMode: v});
  },

  setLowStockThreshold: (v) => {
    const clamped = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    persist('lowStockThreshold', String(clamped));
    window.electronAPI.engine.setLowStockThreshold(clamped);
    set({lowStockThreshold: clamped});
  },

  validateLogFile: async () => {
    const {torchlightPath} = get();
    const valid = torchlightPath
      ? await window.electronAPI.checkLogFile(torchlightPath)
      : false;
    set({logFileValid: valid});
    return valid;
  },
}));
