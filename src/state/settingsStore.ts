import {create} from 'zustand';
import i18n from '@/i18n';
import {AUCTION_TAX_RATE, NO_TAX, type TaxConfig} from '@/domain/valuation';
import {
  DEFAULT_SETTINGS, parseSettings, type RateTimeframe, type Settings, type ThemeMode,
} from '@/shared/settings';

export type {RateTimeframe, ThemeMode};

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

/** The store fields read from the settings table; loot windows in seconds. */
function fromSettings(s: Settings): Omit<SettingsState, 'logFileValid' | 'isLoaded'> {
  const {lootWindowMs: ms, ...rest} = s;
  return {
    ...rest,
    overrealmLootSec:  ms.overrealm  / 1000,
    carjackLootSec:    ms.carjack    / 1000,
    clockworkLootSec:  ms.clockwork  / 1000,
    lunariaLootSec:    ms.lunaria    / 1000,
    sandlordWaveSec:   ms.sandlord   / 1000,
    huntingLootSec:    ms.hunting    / 1000,
    afterlightLootSec: ms.afterlight / 1000,
  };
}

const DEFAULTS: SettingsState = {
  ...fromSettings(DEFAULT_SETTINGS),
  logFileValid: false,
  isLoaded:     false,
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
    const settings = parseSettings(await window.electronAPI.db.settings.getAll());
    i18n.changeLanguage(settings.language);
    const logFileValid = settings.torchlightPath
      ? await window.electronAPI.checkLogFile(settings.torchlightPath)
      : false;
    set({...fromSettings(settings), logFileValid, isLoaded: true});
    const ms = settings.lootWindowMs;
    window.electronAPI.engine.setLowStockThreshold(settings.lowStockThreshold);
    window.electronAPI.engine.setOverrealmLootMs(ms.overrealm);
    window.electronAPI.engine.setCarjackLootMs(ms.carjack);
    window.electronAPI.engine.setClockworkLootMs(ms.clockwork);
    window.electronAPI.engine.setLunariaLootMs(ms.lunaria);
    window.electronAPI.engine.setSandlordWaveMs(ms.sandlord);
    window.electronAPI.engine.setHuntingLootMs(ms.hunting);
    window.electronAPI.engine.setAfterlightLootMs(ms.afterlight);
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
