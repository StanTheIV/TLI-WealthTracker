import type {SeasonalPhase, SeasonalType, Source} from './engine';

export interface DbItem {
  id:        string;
  name:      string;
  type:      string;
  price:     number;
  priceDate: number;
  /** Local-only flag: when true, automated price scrapes from the worker skip
   *  this item. Manual edits in the UI still go through. Excluded from
   *  full_table.json import/export by design — it's per-installation. */
  locked?:   boolean;
}

/** Broadcast on every item mutation in the main process so all renderer windows
 *  keep their itemsStore copies in sync. `changes` is a partial DbItem patch. */
export interface ItemChangedPatch {
  id:      string;
  changes: Partial<Omit<DbItem, 'id'>>;
}

export interface DbSession {
  id:            string;
  name:          string;
  savedAt:       string;
  totalTime:     number;
  mapTime:       number;
  mapCount:      number;
  drops:         Record<string, number>;
  /** Per-source attribution for the source-breakdown pie. Each itemId qty
   *  appears under exactly one source (the owner tracker at write time), so
   *  slices sum to exactly session FE regardless of attribution era. Empty for
   *  legacy sessions saved before this column existed — pie falls back to
   *  per-map-row aggregation in that case. */
  dropsBySource: Partial<Record<Source, Record<string, number>>>;
  /** Which attribution era wrote this session's per-map rows. Decides whether
   *  a parent map row already contains its overlap seasonals' drops — see
   *  SessionAttribution. Stored on every row (v5 backfilled the pre-column ''). */
  attribution:   SessionAttribution;
  /** Item prices captured at save time, keyed by itemId. Lets the detail page
   *  show what the haul was worth *then* alongside what it is worth now.
   *  Empty for sessions saved before this column existed — readers must treat
   *  `{}` as "no snapshot" and fall back to live prices rather than 0. */
  priceSnapshot: Record<string, number>;
  /** Total entry cost (positive magnitudes) — Σ of the primary rows' `spent`.
   *  Not part of `drops`. `{}` for a session that spent nothing; v2 backfilled it. */
  spent:         Record<string, number>;
  /** ms epoch — when the session ended (Stop, or crash-close at startup).
   *  `null` while it is live. Sessions saved before v4 were backfilled with
   *  their `savedAt` (an over-estimate: the save came after the last map). */
  endedAt:       number | null;
}

/**
 * Attribution era of a saved session. Governs how `session_maps` rows combine:
 *   legacy       — old fan-out engine: parent map rows CONTAIN overlap drops.
 *   exclusive    — single-owner: parent map rows EXCLUDE overlap drops, so
 *                  overlap income must be folded back into the parent.
 *   drop-through — current: parent map rows CONTAIN overlap drops again, and
 *                  overlap rows are a pure per-seasonal breakdown of them.
 * Legacy and drop-through share the same sum-across-rows maths (primary rows
 * only); exclusive is the era needing the fold.
 */
export type SessionAttribution = 'legacy' | 'exclusive' | 'drop-through';

/** Per-run breakdown row for a saved session. Written by the engine on every
 *  map exit, on standalone seasonal runs (e.g. Sandlord) that have no
 *  enclosing map, AND on seasonal runs that overlap a regular map (Overrealm,
 *  Clockwork, etc.). Flushed to disk alongside the session's own row. */
export interface DbSessionMap {
  sessionId:    string;
  mapIndex:     number;
  startedAt:    number;        // ms epoch — the run's real start
  /** ms epoch — the run's finish. Not `startedAt + duration` for a run that
   *  froze or went dormant (`duration` is pause-aware). Rows saved before v3
   *  were backfilled with that sum, which was exact for them. */
  endedAt:      number;
  duration:     number;        // ms
  drops:        Record<string, number>;
  spent:        Record<string, number>;
  /** Non-null for seasonal rows (standalone OR overlap); null for plain map rows. */
  seasonalType: SeasonalType | null;
  /** Non-null only for "overlap" seasonal rows that ran inside a regular map —
   *  points at the `mapIndex` of the parent map row. Null for primary rows
   *  (regular maps and standalone seasonals). Whether those drops are ALSO in
   *  the parent row depends on the session's `attribution` era, so aggregations
   *  that sum across rows must branch on it — see SessionAttribution. */
  parentMapIndex: number | null;
  /** Sandlord phase for seasonal_type='sandlord' rows: 'map' (in-map coin tile)
   *  or 'hub' (own-area hub bubble). Null for other rows AND for sandlord rows
   *  written before this column existed — readers must treat null as 'hub',
   *  since in-map tracking didn't exist back then. */
  phase: SeasonalPhase | null;
}

export interface DbWealthDatapoint {
  /** Row id — present on every read, absent when inserting. */
  id?:       number;
  timestamp: number;
  value:     number;
  breakdown: string; // JSON: Record<itemId, {qty: number; price: number; total: number}>
}

/** A wealth_datapoints row as stored: read back, or just inserted. */
export type StoredWealthDatapoint = DbWealthDatapoint & {id: number};

export interface DbItemFilter {
  id:      string;
  name:    string;
  enabled: boolean;
  rules:   string; // JSON FilterRule[]
}

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------

/**
 * One time bucket of an item's history.
 * - `timestamp`: bucket start (ms).
 * - `median`/`p10..p90`/`n`: computed from the MERGED raw listings of every scrape
 *   observation in the bucket (percentiles are never averaged). If the bucket has no
 *   listings, `median` is the median of manual/backfill prices, percentiles are null, `n` is 0.
 * - `medianLo`/`medianHi`: lowest/highest per-observation median in the bucket (how far
 *   the price moved within it); null with fewer than two observations.
 * - `searches`: number of observations with listings merged into the bucket.
 */
export type PriceBucket = {
  timestamp: number;
  median: number;
  p10: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  medianLo: number | null;
  medianHi: number | null;
  n: number;
  searches: number;
};

/** Per-item price movement over a time range (db:prices:movers). */
export interface PriceMover {
  itemId:    string;
  name:      string;
  type:      string;
  first:     number;
  last:      number;
  min:       number;
  max:       number;
  count:     number;
  /** (last - first) / first; null when first is 0. */
  pctChange: number | null;
}

/** One raw price observation for CSV export (db:prices:export). */
export interface PriceExportRow {
  timestamp: number;
  itemId:    string;
  name:      string;
  source:    string;
  price:     number;
  n:         number | null;
  p10:       number | null;
  p25:       number | null;
  p75:       number | null;
  p90:       number | null;
  min:       number | null;
}
