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
