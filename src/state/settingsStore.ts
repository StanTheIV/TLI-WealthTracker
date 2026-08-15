import {create} from 'zustand';
import i18n from '@/i18n';
import {AUCTION_TAX_RATE, NO_TAX, type TaxConfig} from '@/lib/tax';

export type RateTimeframe = 'hour' | 'minute';
export type ThemeMode = 'system' | 'dark' | 'light';

interface SettingsState {
  torchlightPath:           string;
  overlayOpacity:           number;
  clickThroughWhileRunning: boolean;
  pauseTotalTimerInTown:    boolean;
  /** Dashboard live event feed — hidden unless explicitly enabled. */
  showEventFeed:            boolean;
  /** Discount displayed FE by the auction-house cut (fuel exempt). Defaults ON,
   *  so hydration must distinguish "never set" from an explicit opt-out. */
  auctionTaxEnabled:        boolean;
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
  /** Post-encounter Lunaria loot collection window, in seconds. Tracker
   *  pauses (not finishes) on expiry — next strum resumes it. */
  lunariaLootSec:           number;
  /** In-map Sandlord wave-activity window, in seconds. Refreshed by waves
   *  only, never by pickups; the tracker pauses on expiry. */
  sandlordWaveSec:          number;
  /** Post-boss Hunting loot collection window, in seconds. */
  huntingLootSec:           number;
  /** Post-kill Afterlight loot collection window, in seconds. */
  afterlightLootSec:        number;
  isLoaded:                 boolean;
}

interface SettingsActions {
  load:                         () => Promise<void>;
  setTorchlightPath:            (v: string) => void;
  setOverlayOpacity:            (v: number) => void;
  setClickThroughWhileRunning:  (v: boolean) => void;
  setPauseTotalTimerInTown:     (v: boolean) => void;
  setShowEventFeed:             (v: boolean) => void;
  setAuctionTaxEnabled:         (v: boolean) => void;
  setLanguage:                  (v: string) => void;
  validateLogFile:              () => Promise<boolean>;
  setSerperApiKey:              (v: string) => void;
  setRateTimeframe:             (v: RateTimeframe) => void;
  setThemeMode:                 (v: ThemeMode) => void;
  setLowStockThreshold:         (v: number) => void;
  setOverrealmLootSec:          (v: number) => void;
  setCarjackLootSec:            (v: number) => void;
  setClockworkLootSec:          (v: number) => void;
  setLunariaLootSec:            (v: number) => void;
  setSandlordWaveSec:           (v: number) => void;
  setHuntingLootSec:            (v: number) => void;
  setAfterlightLootSec:         (v: number) => void;
}

const DEFAULT_LOOT_SEC = 5;
const DEFAULT_SANDLORD_WAVE_SEC = 10;

const DEFAULTS: SettingsState = {
  torchlightPath:           '',
  overlayOpacity:           0.9,
  clickThroughWhileRunning: false,
  pauseTotalTimerInTown:    false,
  showEventFeed:            false,
  auctionTaxEnabled:        true,
  language:                 'en',
  logFileValid:             false,
  serperApiKey:             '',
  rateTimeframe:            'hour',
  themeMode:                'system',
  lowStockThreshold:        0,
  overrealmLootSec:         DEFAULT_LOOT_SEC,
  carjackLootSec:           DEFAULT_LOOT_SEC,
  clockworkLootSec:         DEFAULT_LOOT_SEC,
  lunariaLootSec:           DEFAULT_LOOT_SEC,
  sandlordWaveSec:          DEFAULT_SANDLORD_WAVE_SEC,
  huntingLootSec:           DEFAULT_LOOT_SEC,
  afterlightLootSec:        DEFAULT_LOOT_SEC,
  isLoaded:                 false,
};

function parseLootSec(raw: string | undefined, fallback: number = DEFAULT_LOOT_SEC): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
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
    const lunariaLootSec   = parseLootSec(raw.lunariaLootMs   ? String(Number(raw.lunariaLootMs)   / 1000) : undefined);
    const huntingLootSec   = parseLootSec(raw.huntingLootMs   ? String(Number(raw.huntingLootMs)   / 1000) : undefined);
    const afterlightLootSec = parseLootSec(raw.afterlightLootMs ? String(Number(raw.afterlightLootMs) / 1000) : undefined);
    const sandlordWaveSec  = parseLootSec(
      raw.sandlordWaveMs ? String(Number(raw.sandlordWaveMs) / 1000) : undefined,
      DEFAULT_SANDLORD_WAVE_SEC,
    );
    set({
      torchlightPath,
      overlayOpacity: raw.overlayOpacity ? Number(raw.overlayOpacity) : 0.9,
      clickThroughWhileRunning: raw.clickThroughWhileRunning === 'true',
      pauseTotalTimerInTown:    raw.pauseTotalTimerInTown === 'true',
      showEventFeed:            raw.showEventFeed === 'true',
      // Not the usual `=== 'true'` idiom: this setting defaults ON, so an
      // absent key must read true while an explicit 'false' opt-out sticks.
      auctionTaxEnabled:        raw.auctionTaxEnabled === undefined ? true : raw.auctionTaxEnabled === 'true',
      language,
      logFileValid,
      serperApiKey: raw.serper_api_key ?? '',
      rateTimeframe: (raw.rateTimeframe === 'minute' ? 'minute' : 'hour') as RateTimeframe,
      themeMode: (['system', 'dark', 'light'].includes(raw.themeMode ?? '') ? raw.themeMode : 'system') as ThemeMode,
      lowStockThreshold,
      overrealmLootSec,
      carjackLootSec,
      clockworkLootSec,
      lunariaLootSec,
      sandlordWaveSec,
      huntingLootSec,
      afterlightLootSec,
      isLoaded: true,
    });
    window.electronAPI.engine.setLowStockThreshold(lowStockThreshold);
    window.electronAPI.engine.setOverrealmLootMs(overrealmLootSec * 1000);
    window.electronAPI.engine.setCarjackLootMs(carjackLootSec * 1000);
    window.electronAPI.engine.setClockworkLootMs(clockworkLootSec * 1000);
    window.electronAPI.engine.setLunariaLootMs(lunariaLootSec * 1000);
    window.electronAPI.engine.setSandlordWaveMs(sandlordWaveSec * 1000);
    window.electronAPI.engine.setHuntingLootMs(huntingLootSec * 1000);
    window.electronAPI.engine.setAfterlightLootMs(afterlightLootSec * 1000);
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

  setShowEventFeed: (v) => {
    persist('showEventFeed', v ? 'true' : 'false');
    set({showEventFeed: v});
  },

  setAuctionTaxEnabled: (v) => {
    persist('auctionTaxEnabled', v ? 'true' : 'false');
    set({auctionTaxEnabled: v});
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

  setLunariaLootSec: (v) => {
    const clamped = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LOOT_SEC;
    persist('lunariaLootMs', String(clamped * 1000));
    window.electronAPI.engine.setLunariaLootMs(clamped * 1000);
    set({lunariaLootSec: clamped});
  },

  setSandlordWaveSec: (v) => {
    const clamped = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_SANDLORD_WAVE_SEC;
    persist('sandlordWaveMs', String(clamped * 1000));
    window.electronAPI.engine.setSandlordWaveMs(clamped * 1000);
    set({sandlordWaveSec: clamped});
  },

  setHuntingLootSec: (v) => {
    const clamped = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LOOT_SEC;
    persist('huntingLootMs', String(clamped * 1000));
    window.electronAPI.engine.setHuntingLootMs(clamped * 1000);
    set({huntingLootSec: clamped});
  },

  setAfterlightLootSec: (v) => {
    const clamped = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LOOT_SEC;
    persist('afterlightLootMs', String(clamped * 1000));
    window.electronAPI.engine.setAfterlightLootMs(clamped * 1000);
    set({afterlightLootSec: clamped});
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

const TAX_ON: TaxConfig = {enabled: true, rate: AUCTION_TAX_RATE};

/** The tax policy every FE display must value through. Returns one of two
 *  module-level constants rather than a fresh object: zustand v5 passes the
 *  selector result straight to `useSyncExternalStore` with no equality check,
 *  so an inline `{enabled, rate}` would make React throw "The result of
 *  getSnapshot should be cached to avoid an infinite loop". */
export function useTaxConfig(): TaxConfig {
  return useSettingsStore(s => (s.auctionTaxEnabled ? TAX_ON : NO_TAX));
}
