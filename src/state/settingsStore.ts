import {create} from 'zustand';
import i18n from '@/i18n';
import {AUCTION_TAX_RATE, NO_TAX, type TaxConfig} from '@/domain/valuation';
import {mechanic, type WindowedSeasonalType} from '@/shared/mechanics';
import {
  DEFAULT_SETTINGS, SETTING_KEYS, parseSettings,
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

/** `v` written to `key` as main will read it back. Setters store this
 *  optimistically and write its string, so the `settings:changed` echo of the
 *  write never moves the UI (opacity 5 → 1, an invalid window → its default). */
function roundTrip(key: string, v: unknown): Settings {
  return parseSettings({[key]: String(v)});
}

const fetchSettings = async (): Promise<Settings> =>
  parseSettings(await window.electronAPI.settings.getAll());

let _subscribed = false;

export const useSettingsStore = create<Store>((set, get) => {
  /** The write through main. A rejected write re-syncs the store from main, so
   *  the UI never keeps a value the DB doesn't have. */
  const persist = (key: string, value: string): void => {
    window.electronAPI.settings.set(key, value)
      .catch(async (err: unknown) => {
        console.error('[settings] persist failed:', err);
        set(await fetchSettings());
      })
      .catch((err: unknown) => console.error('[settings] re-sync failed:', err));
  };

  /** Optimistic local set, then the write through main. */
  const write = <K extends keyof typeof SETTING_KEYS>(field: K, v: Settings[K]) => {
    const key   = SETTING_KEYS[field];
    const value = roundTrip(key, v)[field];
    set({[field]: value} as Pick<Settings, K>);
    persist(key, String(value));
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
      set({...await fetchSettings(), isLoaded: true});
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
    setLowStockThreshold:        v => write('lowStockThreshold', v),

    setLootWindowMs: (type, ms) => {
      const key   = mechanic(type).window.settingKey;
      const value = roundTrip(key, ms).lootWindowMs[type];
      set({lootWindowMs: {...get().lootWindowMs, [type]: value}});
      persist(key, String(value));
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
