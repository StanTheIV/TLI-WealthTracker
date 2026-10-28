import {create} from 'zustand';
import i18n from '@/i18n';
import {AUCTION_TAX_RATE, NO_TAX, type TaxConfig} from '@/domain/valuation';
import {mechanic, type WindowedSeasonalType} from '@/shared/mechanics';
import {
  DEFAULT_SETTINGS, SETTING_KEYS, parsePositiveInt, parseSettings,
  type RateTimeframe, type Settings, type ThemeMode,
} from '@/shared/settings';

export type {RateTimeframe, ThemeMode};

/** The typed settings (main pushes every change on `settings:changed`) plus
 *  this window's runtime state. */
interface SettingsState extends Settings {
  /** Main window only: whether `torchlightPath` holds the game log. */
  logFileValid: boolean;
  isLoaded:     boolean;
}

interface SettingsActions {
  /** Load the table and follow every later change. Both windows call it once;
   *  `checkLogFile` (main window) also validates the torchlight path. */
  init:                         (opts?: {checkLogFile?: boolean}) => Promise<void>;
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
  /** A windowed mechanic's window, in ms; an invalid value writes its default. */
  setLootWindowMs:              (type: WindowedSeasonalType, ms: number) => void;
}

type Store = SettingsState & SettingsActions;

function persist(key: string, value: string): void {
  window.electronAPI.settings.set(key, value).catch(
    (err: unknown) => console.error('[settings] persist failed:', err),
  );
}

/** An integer setting as `parseSettings` would read it back — so the
 *  `settings:changed` echo of the write matches the optimistic value. */
function toStoredInt(v: number, fallback: number, allowZero: boolean): number {
  return parsePositiveInt(String(v), fallback, allowZero);
}

let _subscribed = false;

export const useSettingsStore = create<Store>((set, get) => {
  /** Optimistic local set, then the write through main. */
  const write = <K extends keyof typeof SETTING_KEYS>(field: K, value: Settings[K]) => {
    set({[field]: value} as Pick<Settings, K>);
    persist(SETTING_KEYS[field], String(value));
  };

  return {
    ...DEFAULT_SETTINGS,
    logFileValid: false,
    isLoaded:     false,

    init: async ({checkLogFile = false} = {}) => {
      if (!_subscribed) {
        _subscribed = true;
        window.electronAPI.settings.onChanged(settings => set(settings));
      }
      set({...parseSettings(await window.electronAPI.settings.getAll()), isLoaded: true});
      if (checkLogFile) await get().validateLogFile();
    },

    setTorchlightPath:           v => write('torchlightPath', v),
    setOverlayOpacity:           v => write('overlayOpacity', v),
    setClickThroughWhileRunning: v => write('clickThroughWhileRunning', v),
    setPauseTotalTimerInTown:    v => write('pauseTotalTimerInTown', v),
    setShowEventFeed:            v => write('showEventFeed', v),
    setAuctionTaxEnabled:        v => write('auctionTaxEnabled', v),
    setLanguage:                 v => write('language', v),
    setSerperApiKey:             v => write('serperApiKey', v),
    setRateTimeframe:            v => write('rateTimeframe', v),
    setThemeMode:                v => write('themeMode', v),
    setLowStockThreshold:        v =>
      write('lowStockThreshold', toStoredInt(v, DEFAULT_SETTINGS.lowStockThreshold, /*allowZero*/ true)),

    setLootWindowMs: (type, ms) => {
      const value = toStoredInt(ms, DEFAULT_SETTINGS.lootWindowMs[type], /*allowZero*/ false);
      set({lootWindowMs: {...get().lootWindowMs, [type]: value}});
      persist(mechanic(type).window.settingKey, String(value));
    },

    validateLogFile: async () => {
      const {torchlightPath} = get();
      const valid = torchlightPath
        ? await window.electronAPI.checkLogFile(torchlightPath)
        : false;
      set({logFileValid: valid});
      return valid;
    },
  };
});

// The UI language follows the store in both windows, whichever way it changed
// (load, a local pick, or another window's pick arriving on settings:changed).
useSettingsStore.subscribe((s, prev) => {
  if (s.language !== prev.language) void i18n.changeLanguage(s.language);
});

const TAX_ON: TaxConfig = {enabled: true, rate: AUCTION_TAX_RATE};

/** The tax policy every FE display must value through. Returns one of two
 *  module-level constants rather than a fresh object: zustand v5 passes the
 *  selector result straight to `useSyncExternalStore` with no equality check,
 *  so an inline `{enabled, rate}` would make React throw "The result of
 *  getSnapshot should be cached to avoid an infinite loop". */
export function useTaxConfig(): TaxConfig {
  return useSettingsStore(s => (s.auctionTaxEnabled ? TAX_ON : NO_TAX));
}
