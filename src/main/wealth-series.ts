import type {Logger} from './logger';
import type {WealthHead} from './db';
import {AUCTION_TAX_RATE, NO_TAX, type TaxConfig} from '@/domain/valuation';
import {
  compactWealthPoint, parseWealthBreakdown, rawTypeLookup, wealthBreakdownRows, wealthValuer,
  type CompactWealthPoint, type WealthValuation,
} from '@/domain/wealth';
import type {DbItem, DbItemFilter, StoredWealthDatapoint} from '@/shared/contracts/db';
import type {WealthLatestBreakdown, WealthSeriesPoint} from '@/shared/contracts/wealth';
import type {FilterRule} from '@/shared/item-filter';
import {parseSettings} from '@/shared/settings';

export interface WealthSeriesDeps {
  points: {
    /** id / timestamp / value of the rows in [from, to], timestamp order. */
    heads(from: number, to: number): WealthHead[];
    /** The full rows in [from, to], timestamp order. */
    range(from: number, to: number): StoredWealthDatapoint[];
    /** The latest `limit` rows by timestamp. */
    latest(limit: number): StoredWealthDatapoint[];
  };
  items:    {getAll(): DbItem[]};
  filters:  {getAll(): DbItemFilter[]};
  settings: {getAll(): Record<string, string>};
  log:      Pick<Logger, 'warn'>;
}

const TAX_ON: TaxConfig = {enabled: true, rate: AUCTION_TAX_RATE};

/**
 * The displayed wealth figures. The filter, item types and tax are read per
 * request, so changing them needs no invalidation here (only `wealth:changed`).
 * Parsing the breakdown JSON dominates, so each reading's compact form is
 * cached by id, filled lazily by range. Rows are immutable and ids never
 * reused: an entry goes stale only by deletion — `forget` / `invalidate`.
 */
export class WealthSeries {
  private readonly _cache = new Map<number, CompactWealthPoint>();
  /** The rules string last logged as unreadable — logged once, not per request. */
  private _badRules: string | null = null;

  constructor(private readonly _deps: WealthSeriesDeps) {}

  /** The readings in [from, to] (inclusive), timestamp order. */
  series(from: number, to: number): WealthSeriesPoint[] {
    const heads = this._deps.points.heads(from, to);
    this._fill(heads);
    const value = wealthValuer(this._valuation());
    return heads.map(h => ({id: h.id, ts: h.timestamp, value: value(this._cached(h.id))}));
  }

  /** The latest reading with its Item Breakdown rows; null with no readings. */
  latestBreakdown(): WealthLatestBreakdown | null {
    const [row] = this._deps.points.latest(1);
    if (!row) return null;
    const breakdown = parseWealthBreakdown(row.breakdown);
    const point     = this._cache.get(row.id) ?? this._remember(row.id, compactWealthPoint(row.value, breakdown));
    const v         = this._valuation();
    return {id: row.id, ts: row.timestamp, value: wealthValuer(v)(point), rows: wealthBreakdownRows(breakdown, v)};
  }

  /** One row as displayed — for a reading just recorded (cached for the next `series`). */
  pointOf(row: StoredWealthDatapoint): WealthSeriesPoint {
    const point = this._cache.get(row.id)
      ?? this._remember(row.id, compactWealthPoint(row.value, parseWealthBreakdown(row.breakdown)));
    return {id: row.id, ts: row.timestamp, value: wealthValuer(this._valuation())(point)};
  }

  /** A reading was deleted. */
  forget(id: number): void {
    this._cache.delete(id);
  }

  /** Every reading was deleted. */
  invalidate(): void {
    this._cache.clear();
  }

  /** Cached readings — for tests of the cache's coherence. */
  get cachedCount(): number {
    return this._cache.size;
  }

  /** Caches every head not yet cached, reading each run of consecutive
   *  uncached heads as one range query. */
  private _fill(heads: WealthHead[]): void {
    let i = 0;
    while (i < heads.length) {
      if (this._cache.has(heads[i].id)) { i++; continue; }
      let j = i;
      while (j + 1 < heads.length && !this._cache.has(heads[j + 1].id)) j++;
      // Timestamp bounds can take in cached neighbours sharing a boundary ts; they are skipped.
      for (const row of this._deps.points.range(heads[i].timestamp, heads[j].timestamp)) {
        if (!this._cache.has(row.id)) this._remember(row.id, compactWealthPoint(row.value, parseWealthBreakdown(row.breakdown)));
      }
      i = j + 1;
    }
  }

  private _remember(id: number, point: CompactWealthPoint): CompactWealthPoint {
    this._cache.set(id, point);
    return point;
  }

  private _cached(id: number): CompactWealthPoint {
    const point = this._cache.get(id);
    // Unreachable: _fill read the same rows synchronously, and main is the only writer.
    if (!point) throw new Error(`Wealth reading ${id} vanished between reads`);
    return point;
  }

  private _valuation(): WealthValuation {
    return {
      tax:       parseSettings(this._deps.settings.getAll()).auctionTaxEnabled ? TAX_ON : NO_TAX,
      rawTypeOf: rawTypeLookup(this._deps.items.getAll()),
      rules:     this._activeRules(),
    };
  }

  /** The enabled filter's rules; none (and a log line) when they don't parse. */
  private _activeRules(): FilterRule[] {
    const active = this._deps.filters.getAll().find(f => f.enabled);
    if (!active) return [];
    try {
      const rules: unknown = JSON.parse(active.rules);
      if (Array.isArray(rules)) return rules as FilterRule[];
    } catch {
      // logged below
    }
    if (this._badRules !== active.rules) {
      this._badRules = active.rules;
      this._deps.log.warn('wealth', `Filter '${active.id}' has unreadable rules; wealth is shown unfiltered`);
    }
    return [];
  }
}
