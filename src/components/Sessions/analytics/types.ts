import type {DbSession, DbSessionMap, SeasonalType, Source} from '@/types/electron';
import type {ItemType} from '@/types/itemType';

// ---------------------------------------------------------------------------
// Valuation — every FE figure carries both its save-time and present-day value
// ---------------------------------------------------------------------------

/** One FE figure valued twice. `snapshot` uses prices frozen when the session
 *  was saved; `live` uses today's. They are equal when the session predates the
 *  price_snapshot column. */
export interface Valuation {
  snapshot: number;
  live:     number;
}

/** Turns a drop dict into a Valuation. Built once per valuation policy so the
 *  snapshot/live duplication lives in a closure rather than at every call site. */
export type Valuator = (drops: Record<string, number>) => Valuation;

export interface PriceLookup {
  snapshot:    (itemId: string) => number;
  live:        (itemId: string) => number;
  /** False when the session has no usable snapshot, so `snapshot` aliases
   *  `live`. The UI hides the drift column rather than showing a fake 0%. */
  hasSnapshot: boolean;
  /** True when this specific item is missing from the snapshot and its
   *  snapshot price fell back to live. */
  isMissing:   (itemId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Row classification
// ---------------------------------------------------------------------------

export type RowKind = 'map' | 'standalone-seasonal' | 'overlap-seasonal';

/** A mechanic bucket. `unknown` catches overlap rows with a null seasonalType —
 *  guessing a real mechanic would silently misattribute time and value. */
export type MechanicKey = 'map' | 'town' | 'unknown' | SeasonalType;

export interface ClassifiedRow {
  row:      DbSessionMap;
  kind:     RowKind;
  /** Bucket this row's time and value land in. 'map' for plain map rows. */
  mechanic: MechanicKey;
  /** Whether this row's clock ran concurrently with a live map clock. Decides
   *  whether its time is carved out of plain-map time or out of town time.
   *  Only meaningful for overlap rows. See MAP_FREEZING_SEASONALS. */
  concurrentWithMap: boolean;
  /** Resolved parent row; null when unresolvable (row is then reclassified as
   *  standalone so its time and value never vanish from the aggregates). */
  parent:   DbSessionMap | null;
  /** Positive-only drop value. Negative quantities are auction-house
   *  conversions, not income. */
  income:   Valuation;
  /** Entry materials consumed. */
  cost:     Valuation;
  /** Active seconds. Excludes paused time — see docs/GAMEPLAY.md. */
  seconds:  number;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface MechanicStats {
  key:         MechanicKey;
  runs:        number;
  seconds:     number;
  /** Share of the session's accounted time. Sums to 100 across all buckets. */
  timePct:     number;
  income:      Valuation;
  cost:        Valuation;
  net:         Valuation;
  valuePct:    Valuation;
  fePerHour:   Valuation;
  avgPerRun:   Valuation;
  avgSeconds:  number;
  /** True when this bucket's time is carved out of plain-map time rather than
   *  town time. Drives the "nested" hint in the UI. */
  nestedInMap: boolean;
}

/** Shares are per-leg: switching the page to snapshot values must switch the
 *  percentages with them, or they describe a total that is no longer on screen. */
export interface SourceSlice {
  source: Source;
  value:  Valuation;
  pct:    Valuation;
}

export interface TypeSlice {
  type:  ItemType;
  value: Valuation;
  pct:   Valuation;
}

export interface DroppedItemRow {
  itemId:    string;
  name:      string;
  type:      ItemType;
  /** False when the id isn't in the items table — rendered as `#id`. */
  known:     boolean;
  /** May be negative (auction-house conversion). Shown verbatim. */
  qty:       number;
  unitPrice: Valuation;
  total:     Valuation;
  /** Share of positive session income, per leg. Negative for conversion rows. */
  pct:       Valuation;
  perHour:   Valuation;
  /** Maps run per unit dropped. Null when qty <= 0 or no maps were run. */
  mapsPerDrop:     number | null;
  topSource:       Source | null;
  /** True when this item had no snapshot price and fell back to live. */
  snapshotMissing: boolean;
}

export interface ConsumedItemRow {
  itemId:    string;
  name:      string;
  type:      ItemType;
  known:     boolean;
  qty:       number;
  unitPrice: Valuation;
  total:     Valuation;
  pct:       Valuation;
  /** Units consumed per map run. Null when no maps were run. */
  perMap:    number | null;
  /** How many distinct runs consumed this item. */
  runsUsing: number;
  snapshotMissing: boolean;
}

export interface PerMapPoint {
  mapIndex:  number;
  /** Bucket of the primary row itself — 'map', or the type for a standalone. */
  mechanic:  MechanicKey;
  seconds:   number;
  /** Income from the primary row with nested overlap income removed, so the
   *  segments of a stacked bar sum to the row total exactly once. */
  mapIncome:      Valuation;
  seasonalIncome: Valuation;
  bySeasonal:     Partial<Record<MechanicKey, Valuation>>;
  cost:      Valuation;
  net:       Valuation;
  cumulative: Valuation;
}

export interface HistogramBucket {
  from:  number;
  to:    number;
  count: number;
}

export interface TimelineSegment {
  key:      string;
  mapIndex: number;
  mechanic: MechanicKey;
  kind:     RowKind;
  seconds:  number;
  income:   Valuation;
  cost:     Valuation;
  children: TimelineSegment[];
}

// ---------------------------------------------------------------------------
// Warnings — non-fatal data-integrity notes, surfaced in the UI
// ---------------------------------------------------------------------------

export type AnalyticsWarning =
  | {code: 'time-reconciliation';    residualSeconds: number}
  | {code: 'map-count-mismatch';     mapCount: number; rows: number}
  | {code: 'orphan-overlap-row';     mapIndex: number}
  | {code: 'overlap-exceeds-parent'; mapIndex: number}
  | {code: 'nested-exceeds-map-time'; nestedSeconds: number; mapSeconds: number}
  | {code: 'unknown-seasonal-type';  mapIndex: number};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface SessionTotals {
  totalSeconds:    number;
  mapSeconds:      number;
  /** Time in seasonals that ran OUTSIDE the map clock (arcana, vorex,
   *  sandlord) — the portion that must be carved out of town time. */
  exclusiveSeasonalSeconds: number;
  townSeconds:     number;
  /** Plain-map time: map clock minus concurrently-nested seasonal time. */
  plainMapSeconds: number;
  mapCount:        number;
  income:          Valuation;
  cost:            Valuation;
  net:             Valuation;
  netPerHour:      Valuation;
  incomePerHour:   Valuation;
  /** Share of session time spent in content rather than town. */
  efficiencyPct:   number;
  /** Null when no maps were run — 0.00 would claim materials were free. */
  costPerMap:      Valuation | null;
  /** Income divided by cost. Null when nothing was spent. */
  roiMultiple:     {snapshot: number | null; live: number | null};
  /** FE a map must yield to cover its own materials. Null when no maps ran. */
  breakEvenYield:  Valuation | null;
  mapsUnprofitable: number;
  uniqueItems:     number;
  totalQty:        number;
  /** Percentage change from snapshot to live value. Null when there is no
   *  snapshot or the snapshot value is zero. */
  driftPct:        number | null;
}

export interface MapNetStats {
  mean:      Valuation;
  median:    Valuation;
  best:      {mapIndex: number; net: Valuation} | null;
  worst:     {mapIndex: number; net: Valuation} | null;
  histogram: HistogramBucket[];
}

export interface SessionAnalytics {
  meta: {
    sessionId:   string;
    attribution: DbSession['attribution'];
    hasSnapshot: boolean;
    /** True when the session has no per-run rows — per-map sections hide
     *  entirely rather than rendering empty charts. */
    noMapRows:   boolean;
    /** True when dropsBySource is empty (legacy) and the by-source breakdown
     *  falls back to per-row aggregation. */
    legacyBySource: boolean;
    warnings:    AnalyticsWarning[];
  };
  totals:      SessionTotals;
  mechanics:   MechanicStats[];
  bySource:    SourceSlice[];
  byType:      TypeSlice[];
  perMap:      PerMapPoint[];
  mapNetStats: MapNetStats;
  dropped:     DroppedItemRow[];
  consumed:    ConsumedItemRow[];
  timeline:    TimelineSegment[];
}
