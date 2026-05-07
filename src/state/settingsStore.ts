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
  /** Post-exit Overrealm loot collection window, in seconds. */
  overrealmLootSec:         number;
  /** Post-combat Carjack loot collection window, in seconds. */
  carjackLootSec:           number;
  /** Post-turn-in Clockwork loot collection window, in seconds. */
  clockworkLootSec:         number;
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
  setOverrealmLootSec:          (v: number) => void;
  setCarjackLootSec:            (v: number) => void;
  setClockworkLootSec:          (v: number) => void;
}

const DEFAULT_LOOT_SEC = 5;

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
  overrealmLootSec:         DEFAULT_LOOT_SEC,
  carjackLootSec:           DEFAULT_LOOT_SEC,
  clockworkLootSec:         DEFAULT_LOOT_SEC,
  isLoaded:                 false,
};

function parseLootSec(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LOOT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOOT_SEC;
  return Math.floor(n);
}

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
    const overrealmLootSec = parseLootSec(raw.overrealmLootMs ? String(Number(raw.overrealmLootMs) / 1000) : undefined);
    const carjackLootSec   = parseLootSec(raw.carjackLootMs   ? String(Number(raw.carjackLootMs)   / 1000) : undefined);
    const clockworkLootSec = parseLootSec(raw.clockworkLootMs ? String(Number(raw.clockworkLootMs) / 1000) : undefined);
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
      overrealmLootSec,
      carjackLootSec,
      clockworkLootSec,
      isLoaded: true,
    });
    window.electronAPI.engine.setLowStockThreshold(lowStockThreshold);
    window.electronAPI.engine.setOverrealmLootMs(overrealmLootSec * 1000);
    window.electronAPI.engine.setCarjackLootMs(carjackLootSec * 1000);
    window.electronAPI.engine.setClockworkLootMs(clockworkLootSec * 1000);
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

  setOverrealmLootSec: (v) => {
    const clamped = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LOOT_SEC;
    persist('overrealmLootMs', String(clamped * 1000));
    window.electronAPI.engine.setOverrealmLootMs(clamped * 1000);
    set({overrealmLootSec: clamped});
  },

  setCarjackLootSec: (v) => {
    const clamped = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LOOT_SEC;
    persist('carjackLootMs', String(clamped * 1000));
    window.electronAPI.engine.setCarjackLootMs(clamped * 1000);
    set({carjackLootSec: clamped});
  },

  setClockworkLootSec: (v) => {
    const clamped = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LOOT_SEC;
    persist('clockworkLootMs', String(clamped * 1000));
    window.electronAPI.engine.setClockworkLootMs(clamped * 1000);
    set({clockworkLootSec: clamped});
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
