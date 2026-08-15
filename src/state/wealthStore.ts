import {create} from 'zustand';
import type {DbItem, DbWealthDatapoint} from '@/types/electron';
import {taxedValue, type TaxConfig} from '@/lib/tax';

export interface BreakdownEntry {
  qty:   number;
  price: number;
  total: number;
}

export type Breakdown = Record<string, BreakdownEntry>;

/** A datapoint with its breakdown parsed once at fetch. `value` stays the GROSS
 *  figure the main process stored; `taxedValueFor` derives the net one, since
 *  the stored aggregate is type-blind and can't honour the fuel exemption. */
export interface WealthPoint extends DbWealthDatapoint {
  parsed: Breakdown | null;
}

/**
 * Net value of one datapoint under the given tax policy.
 *
 * Rows written before the `breakdown` column exists carry '{}' and have no per
 * item detail to tax, so they fall back to the stored gross value. A history
 * spanning that migration therefore shows a step where the detail begins —
 * unavoidable, since the information to tax those rows was never recorded.
 */
export function pointValue(
  point: WealthPoint,
  items: Record<string, DbItem>,
  tax:   TaxConfig,
): number {
  if (!tax.enabled) return point.value;
  const parsed = point.parsed;
  if (!parsed || Object.keys(parsed).length === 0) return point.value;

  let total = 0;
  for (const [itemId, entry] of Object.entries(parsed)) {
    total += taxedValue(entry.qty, entry.price, items[itemId]?.type, tax);
  }
  return total;
}

function toPoints(rows: DbWealthDatapoint[]): WealthPoint[] {
  return rows.map((row) => {
    try {
      return {...row, parsed: JSON.parse(row.breakdown) as Breakdown};
    } catch {
      return {...row, parsed: null};
    }
  });
}

export type WealthRange = '1d' | '3d' | '7d' | '1m' | 'all';

interface WealthState {
  datapoints:      WealthPoint[];
  latestBreakdown: Breakdown;
  latestTimestamp: number | null;
  range:           WealthRange;
  isLoaded:        boolean;
}

interface WealthActions {
  load:     () => Promise<void>;
  refresh:  () => Promise<void>;
  setRange: (range: WealthRange) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_MS: Record<Exclude<WealthRange, 'all'>, number> = {
  '1d': 1  * DAY_MS,
  '3d': 3  * DAY_MS,
  '7d': 7  * DAY_MS,
  '1m': 30 * DAY_MS,
};

const WEALTH_RANGE_KEY = 'wealthChartRange';
const VALID_RANGES: readonly WealthRange[] = ['1d', '3d', '7d', '1m', 'all'];

/** The chart range the user last picked, or null to keep the default — a value
 *  written by an older build that no longer exists is treated as absent. */
async function loadPersistedRange(): Promise<WealthRange | null> {
  try {
    const raw = await window.electronAPI.db.settings.getAll();
    const stored = raw[WEALTH_RANGE_KEY] as WealthRange | undefined;
    return stored && VALID_RANGES.includes(stored) ? stored : null;
  } catch (err) {
    console.error('[wealth] load range failed:', err);
    return null;
  }
}

function parseBreakdown(point: DbWealthDatapoint | undefined): {breakdown: Breakdown; latestTimestamp: number | null} {
  if (!point) return {breakdown: {}, latestTimestamp: null};
  try {
    return {breakdown: JSON.parse(point.breakdown) as Breakdown, latestTimestamp: point.timestamp};
  } catch {
    return {breakdown: {}, latestTimestamp: point.timestamp};
  }
}

/** Parses each row's breakdown once here rather than per render: an 'all' range
 *  is thousands of rows, each holding an object per inventory item. */
async function fetchPoints(range: WealthRange): Promise<WealthPoint[]> {
  const now = Date.now();
  const rows = range === 'all'
    ? await window.electronAPI.db.wealth.getRange(0, now)
    : await window.electronAPI.db.wealth.getRange(now - RANGE_MS[range], now);
  return toPoints(rows);
}

async function fetchLatest(): Promise<DbWealthDatapoint | undefined> {
  const points = await window.electronAPI.db.wealth.getLatest(1);
  return points[points.length - 1];
}

export const useWealthStore = create<WealthState & WealthActions>((set, get) => ({
  datapoints:      [],
  latestBreakdown: {},
  latestTimestamp: null,
  range:           '1m',
  isLoaded:        false,

  load: async () => {
    const range = await loadPersistedRange() ?? get().range;
    const [points, latest] = await Promise.all([fetchPoints(range), fetchLatest()]);
    const {breakdown, latestTimestamp} = parseBreakdown(latest);
    set({range, datapoints: points, latestBreakdown: breakdown, latestTimestamp, isLoaded: true});
  },

  refresh: async () => {
    const {range} = get();
    const [points, latest] = await Promise.all([fetchPoints(range), fetchLatest()]);
    const {breakdown, latestTimestamp} = parseBreakdown(latest);
    set({datapoints: points, latestBreakdown: breakdown, latestTimestamp});
  },

  setRange: async (range) => {
    set({range});
    window.electronAPI.db.settings.set(WEALTH_RANGE_KEY, range).catch(
      (err: unknown) => console.error('[wealth] persist range failed:', err)
    );
    const points = await fetchPoints(range);
    set({datapoints: points});
  },
}));
