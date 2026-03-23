import {create} from 'zustand';
import i18n from '@/i18n';

export type RateTimeframe = 'hour' | 'minute';

interface SettingsState {
  torchlightPath: string;
  overlayOpacity: number;
  language:       string;
  logFileValid:   boolean;
  serperApiKey:   string;
  rateTimeframe:  RateTimeframe;
  isLoaded:       boolean;
}

interface SettingsActions {
  load:               () => Promise<void>;
  setTorchlightPath:  (v: string) => void;
  setOverlayOpacity:  (v: number) => void;
  setLanguage:        (v: string) => void;
  validateLogFile:    () => Promise<boolean>;
  setSerperApiKey:    (v: string) => void;
  setRateTimeframe:   (v: RateTimeframe) => void;
}

const DEFAULTS: SettingsState = {
  torchlightPath: '',
  overlayOpacity: 0.9,
  language:       'en',
  logFileValid:   false,
  serperApiKey:   '',
  rateTimeframe:  'hour',
  isLoaded:       false,
};

function persist(key: string, value: string) {
  window.electronAPI.db.settings.set(key, value).catch(
    (err: unknown) => console.error('[settings] persist failed:', err)
  );
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
    set({
      torchlightPath,
      overlayOpacity: raw.overlayOpacity ? Number(raw.overlayOpacity) : 0.9,
      language,
      logFileValid,
      serperApiKey: raw.serper_api_key ?? '',
      rateTimeframe: (raw.rateTimeframe === 'minute' ? 'minute' : 'hour') as RateTimeframe,
      isLoaded: true,
    });
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

  validateLogFile: async () => {
    const {torchlightPath} = get();
    const valid = torchlightPath
      ? await window.electronAPI.checkLogFile(torchlightPath)
      : false;
    set({logFileValid: valid});
    return valid;
  },
}));
