/**
 * The typed settings. `parseSettings` is THE reader of the string settings
 * table — main window, overlay and engine; a missing or invalid value falls
 * back to its field's default. Loot windows come from the MECHANICS rows.
 */
import {WINDOWED_MECHANICS as WINDOWED, type WindowedSeasonalType} from './mechanics';

export type RateTimeframe = 'hour' | 'minute';
export type ThemeMode = 'system' | 'dark' | 'light';

export interface Settings {
  readonly torchlightPath:           string;
  /** Overlay background opacity, in [0, 1]. */
  readonly overlayOpacity:           number;
  readonly clickThroughWhileRunning: boolean;
  readonly pauseTotalTimerInTown:    boolean;
  /** Dashboard live event feed — hidden unless explicitly enabled. */
  readonly showEventFeed:            boolean;
  /** Discount displayed FE by the auction-house cut (fuel exempt). Defaults
   *  ON: only an explicit 'false' opts out. */
  readonly auctionTaxEnabled:        boolean;
  readonly language:                 string;
  readonly rateTimeframe:            RateTimeframe;
  readonly themeMode:                ThemeMode;
  /** The map-material qty at/under which warnings fire; 0 is valid. */
  readonly lowStockThreshold:        number;
  /** Each windowed mechanic's window (ms) — see `MechanicWindow`. */
  readonly lootWindowMs:             Readonly<Record<WindowedSeasonalType, number>>;
}

/** The DB key of every field but `lootWindowMs` (its keys are the MECHANICS
 *  rows' `window.settingKey`). */
export const SETTING_KEYS = {
  torchlightPath:           'torchlightPath',
  overlayOpacity:           'overlayOpacity',
  clickThroughWhileRunning: 'clickThroughWhileRunning',
  pauseTotalTimerInTown:    'pauseTotalTimerInTown',
  showEventFeed:            'showEventFeed',
  auctionTaxEnabled:        'auctionTaxEnabled',
  language:                 'language',
  rateTimeframe:            'rateTimeframe',
  themeMode:                'themeMode',
  lowStockThreshold:        'lowStockThreshold',
} as const satisfies Record<Exclude<keyof Settings, 'lootWindowMs'>, string>;

/** The keys the engine reads: a change to one of them must reconfigure it. */
export const ENGINE_SETTING_KEYS: ReadonlySet<string> = new Set([
  ...WINDOWED.map(m => m.window.settingKey),
  SETTING_KEYS.lowStockThreshold,
]);

const RATE_TIMEFRAMES: readonly RateTimeframe[] = ['hour', 'minute'];
const THEME_MODES:     readonly ThemeMode[]     = ['system', 'dark', 'light'];

export const DEFAULT_SETTINGS: Settings = {
  torchlightPath:           '',
  overlayOpacity:           0.9,
  clickThroughWhileRunning: false,
  pauseTotalTimerInTown:    false,
  showEventFeed:            false,
  auctionTaxEnabled:        true,
  language:                 'en',
  rateTimeframe:            'hour',
  themeMode:                'system',
  lowStockThreshold:        0,
  lootWindowMs:             Object.fromEntries(WINDOWED.map(m => [m.key, m.window.defaultMs])) as
    Record<WindowedSeasonalType, number>,
};

/**
 * Read an integer setting. Missing, non-numeric, or (after flooring) below the
 * minimum → `fallback`. The minimum is 1, or 0 with `allowZero`. Never -0.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number, allowZero: boolean): number {
  if (raw === undefined) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return (allowZero ? n >= 0 : n > 0) ? n + 0 : fallback;   // + 0: '-0' reads as +0
}

/** Every windowed mechanic's window (ms, ≥ 1) from its row's setting key. */
function lootWindows(raw: Readonly<Record<string, string>>): Record<WindowedSeasonalType, number> {
  const out = {} as Record<WindowedSeasonalType, number>;
  for (const m of WINDOWED) out[m.key] = parsePositiveInt(raw[m.window.settingKey], m.window.defaultMs, false);
  return out;
}

/** Missing or blank → the default (`Number('  ')` is 0); a finite value is clamped to [0, 1]. */
function parseOpacity(raw: string | undefined): number {
  const n = raw === undefined || !/\S/.test(raw) ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_SETTINGS.overlayOpacity;
}

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.find(v => v === raw) ?? fallback;
}

/** The typed settings of a raw settings table. Never throws. */
export function parseSettings(raw: Readonly<Record<string, string>>): Settings {
  const K = SETTING_KEYS;
  const D = DEFAULT_SETTINGS;
  return {
    torchlightPath:           raw[K.torchlightPath] ?? D.torchlightPath,
    overlayOpacity:           parseOpacity(raw[K.overlayOpacity]),
    clickThroughWhileRunning: raw[K.clickThroughWhileRunning] === 'true',
    pauseTotalTimerInTown:    raw[K.pauseTotalTimerInTown] === 'true',
    showEventFeed:            raw[K.showEventFeed] === 'true',
    auctionTaxEnabled:        raw[K.auctionTaxEnabled] !== 'false',
    language:                 raw[K.language] ?? D.language,
    rateTimeframe:            parseEnum(raw[K.rateTimeframe], RATE_TIMEFRAMES, D.rateTimeframe),
    themeMode:                parseEnum(raw[K.themeMode], THEME_MODES, D.themeMode),
    lowStockThreshold:        parsePositiveInt(raw[K.lowStockThreshold], D.lowStockThreshold, /*allowZero*/ true),
    lootWindowMs:             lootWindows(raw),
  };
}
