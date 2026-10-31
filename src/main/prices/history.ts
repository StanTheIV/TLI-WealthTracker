/** Pure price-history helpers (no DB / electron imports). */
import {median, percentile} from '@/lib/percentiles';
import type {PriceBucket} from '@/shared/contracts/db';

export type PriceSummary = {n: number; p10: number; p25: number; p75: number; p90: number; min: number};

/** Order-book summary of one search. Input may be unsorted; it is not mutated. */
export function summarize(listings: number[]): PriceSummary {
  const s = listings.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return {n: 0, p10: 0, p25: 0, p75: 0, p90: 0, min: 0};
  return {
    n: s.length,
    p10: percentile(s, 0.1),
    p25: percentile(s, 0.25),
    p75: percentile(s, 0.75),
    p90: percentile(s, 0.9),
    min: s[0],
  };
}

type DupKey = {timestamp: number; price: number; n: number | null};

/** True when `next` repeats `last` (same median and same n) within the window. */
export function shouldSkipDuplicate(
  last: DupKey | undefined,
  next: DupKey,
  windowMs = 120_000,
): boolean {
  if (!last) return false;
  return (
    last.price === next.price &&
    last.n === next.n &&
    Math.abs(next.timestamp - last.timestamp) <= windowMs
  );
}

/** Backfill compression: keep only points where an item's price changed. */
export function compressChangePoints<T extends {itemId: string; timestamp: number; price: number}>(
  points: T[],
): T[] {
  const valid = points.filter(p => Number.isFinite(p.price) && p.price > 0);
  valid.sort((a, b) =>
    a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : a.timestamp - b.timestamp,
  );
  const out: T[] = [];
  let lastItem: string | undefined;
  let lastPrice = NaN;
  for (const p of valid) {
    if (p.itemId !== lastItem || p.price !== lastPrice) {
      out.push(p);
      lastItem = p.itemId;
      lastPrice = p.price;
    }
  }
  return out;
}

export type BucketObservation = {
  id: number;
  timestamp: number;
  price: number;
  source: string;
  n?: number | null;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Bucket start: local midnight for daily buckets (days follow the user's clock), epoch-aligned otherwise. */
function bucketKey(ts: number, bucketMs: number): number {
  if (bucketMs <= 0) return ts;
  if (bucketMs === DAY_MS) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  return Math.floor(ts / bucketMs) * bucketMs;
}

/** Group observations into `bucketMs` buckets (0 = one per timestamp). Empty buckets are omitted. */
export function bucket(
  observations: BucketObservation[],
  listingsByObs: Map<number, number[]>,
  bucketMs: number,
): PriceBucket[] {
  const groups = new Map<number, BucketObservation[]>();
  for (const o of observations) {
    const key = bucketKey(o.timestamp, bucketMs);
    const g = groups.get(key);
    if (g) g.push(o);
    else groups.set(key, [o]);
  }

  const out: PriceBucket[] = [];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(key)!;
    const merged: number[] = [];
    const listingless: number[] = [];
    let searches = 0;
    for (const o of group) {
      const l = listingsByObs.get(o.id);
      if (l && l.length > 0) {
        merged.push(...l);
        searches++;
      } else {
        listingless.push(o.price);
      }
    }

    // Each observation's `price` already is its own median, so the spread of
    // medians needs no extra storage.
    const medians = group.map(o => o.price);
    const medianLo = medians.length >= 2 ? Math.min(...medians) : null;
    const medianHi = medians.length >= 2 ? Math.max(...medians) : null;

    if (merged.length > 0) {
      merged.sort((a, b) => a - b);
      out.push({
        timestamp: key,
        median: median(merged),
        p10: percentile(merged, 0.1),
        p25: percentile(merged, 0.25),
        p75: percentile(merged, 0.75),
        p90: percentile(merged, 0.9),
        medianLo, medianHi,
        n: merged.length,
        searches,
      });
    } else {
      out.push({
        timestamp: key,
        median: median(listingless),
        p10: null, p25: null, p75: null, p90: null,
        medianLo, medianHi,
        n: 0,
        searches: 0,
      });
    }
  }
  return out;
}

/** Hourly up to a two-day span, daily beyond. Always bucketed: one point per search would collapse the median spread. */
export function pickBucketMs(spanMs: number): number {
  return spanMs <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
}

export type BackfillPoint = {itemId: string; timestamp: number; price: number};

/**
 * Derive one-time backfill points from legacy data, already compressed to change-points.
 * - wealth rows: `breakdown` = `{itemId: {qty, price, total}}` priced at `timestamp`
 * - session rows: `price_snapshot` = `{itemId: price}` priced at `Date.parse(saved_at)`
 * Malformed JSON / bad timestamps / non-positive prices are skipped, never thrown on.
 */
export function extractBackfillPoints(
  wealthRows: {timestamp: number; breakdown: string}[],
  sessionRows: {saved_at: string; price_snapshot: string}[],
): BackfillPoint[] {
  const raw: BackfillPoint[] = [];
  const parse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  for (const row of wealthRows) {
    if (!Number.isFinite(row.timestamp)) continue;
    const bd = parse(row.breakdown);
    if (!bd) continue;
    for (const [itemId, entry] of Object.entries(bd)) {
      const price = entry && typeof entry === 'object' ? (entry as {price?: unknown}).price : undefined;
      if (typeof price === 'number') raw.push({itemId, timestamp: row.timestamp, price});
    }
  }
  for (const row of sessionRows) {
    const ts = Date.parse(row.saved_at);
    if (!Number.isFinite(ts)) continue;
    const snap = parse(row.price_snapshot);
    if (!snap) continue;
    for (const [itemId, price] of Object.entries(snap)) {
      if (typeof price === 'number') raw.push({itemId, timestamp: ts, price});
    }
  }
  return compressChangePoints(raw);
}
