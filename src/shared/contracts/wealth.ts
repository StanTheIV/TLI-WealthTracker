/** Wealth as displayed: main values the stored gross readings under the
 *  current filter, today's item types and the tax; the renderer only shows it. */

/** One displayed reading: a stored wealth_datapoints row, valued. */
export interface WealthSeriesPoint {
  /** The stored row's id. */
  id:    number;
  /** The stored row's timestamp (ms epoch). */
  ts:    number;
  value: number;
}

/** One Item Breakdown row: an included item of a reading with a positive
 *  quantity — its stored qty, the taxed unit price and the taxed total. */
export interface WealthBreakdownRow {
  id:        string;
  qty:       number;
  unitPrice: number;
  total:     number;
}

/** The latest reading with its Item Breakdown rows, which sum to `value`. A
 *  reading without per-item detail has no rows and shows its stored value. */
export interface WealthLatestBreakdown extends WealthSeriesPoint {
  rows: WealthBreakdownRow[];
}
