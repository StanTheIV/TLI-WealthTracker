/** Pure helpers for the price history chart, formatters and CSV export. */
import type {PriceBucket} from '@/main/prices/history';
import type {LeagueRange} from './leagues';
import type {PriceExportRow} from '@/types/electron';

export type ChartRow = {
  t: number;
  /** True for the synthetic null row inserted at a league boundary. */
  gap: boolean;
  median: number | null;
  p25: number | null;
  p75: number | null;
  medianLo: number | null;
  medianHi: number | null;
  /** Order-book spread: [p25, p75] of all listings in the bucket (recharts range area). */
  iqr: [number, number] | null;
  /** Median spread: [lowest, highest] per-search median in the bucket. */
  medianBand: [number, number] | null;
  n: number;
  searches: number;
};

const pos = (v: number | null, log: boolean): number | null =>
  v === null || !Number.isFinite(v) || (log && v <= 0) ? null : v;

const band = (lo: number | null, hi: number | null): [number, number] | null =>
  lo !== null && hi !== null ? [lo, hi] : null;

/**
 * Buckets -> chart rows. In log mode non-positive values are dropped (a log axis
 * cannot show them). A null-median row is inserted just before every league start
 * strictly inside (from, to) so lines break at league boundaries.
 */
export function buildChartRows(
  buckets: PriceBucket[],
  ranges: LeagueRange[],
  from: number,
  to: number,
  log: boolean,
): ChartRow[] {
  const rows: ChartRow[] = [];
  for (const b of buckets) {
    // Manual/backfill-only buckets have null percentiles: they still feed the
    // median line (most pre-recording history is backfill) but draw no band.
    const p25 = pos(b.p25, log), p75 = pos(b.p75, log);
    const medianLo = pos(b.medianLo, log), medianHi = pos(b.medianHi, log);
    rows.push({
      t: b.timestamp, gap: false, median: pos(b.median, log),
      p25, p75, medianLo, medianHi,
      iqr: band(p25, p75), medianBand: band(medianLo, medianHi),
      n: b.n, searches: b.searches,
    });
  }
  for (const r of ranges) {
    if (r.from > from && r.from < to) {
      rows.push({
        t: r.from - 1, gap: true, median: null,
        p25: null, p75: null, medianLo: null, medianHi: null, iqr: null, medianBand: null, n: 0, searches: 0,
      });
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

/** Price with enough precision for sub-1 FE items (0.0015) and compact above 1k. */
export function formatPrice(v: number): string {
  // Every branch goes through toLocaleString so the decimal separator is consistent.
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString(undefined, {maximumFractionDigits: 2})}M`;
  if (abs >= 1_000)     return `${(v / 1_000).toLocaleString(undefined, {maximumFractionDigits: 1})}k`;
  if (abs >= 1)         return v.toLocaleString(undefined, {maximumFractionDigits: 2});
  if (abs === 0)        return '0';
  return v.toLocaleString(undefined, {maximumSignificantDigits: 2});
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const CSV_HEADER = 'timestamp,item_id,name,source,price,n,p10,p25,p75,p90,min';

/** RFC 4180 field escaping: quote when it contains comma, quote or newline. */
export function csvField(v: string | number | null): string {
  if (v === null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: PriceExportRow[]): string {
  const lines = rows.map(r =>
    [
      new Date(r.timestamp).toISOString(), r.itemId, r.name, r.source, r.price,
      r.n, r.p10, r.p25, r.p75, r.p90, r.min,
    ].map(csvField).join(','),
  );
  return [CSV_HEADER, ...lines].join('\r\n') + '\r\n';
}
