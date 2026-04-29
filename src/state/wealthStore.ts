import {create} from 'zustand';
import type {DbWealthDatapoint} from '@/types/electron';

export interface BreakdownEntry {
  qty:   number;
  price: number;
  total: number;
}

export type Breakdown = Record<string, BreakdownEntry>;

export type WealthRange = '1d' | '3d' | '7d' | '1m' | 'all';

interface WealthState {
  datapoints:      DbWealthDatapoint[];
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

function parseBreakdown(point: DbWealthDatapoint | undefined): {breakdown: Breakdown; latestTimestamp: number | null} {
  if (!point) return {breakdown: {}, latestTimestamp: null};
  try {
    return {breakdown: JSON.parse(point.breakdown) as Breakdown, latestTimestamp: point.timestamp};
  } catch {
    return {breakdown: {}, latestTimestamp: point.timestamp};
  }
}

async function fetchPoints(range: WealthRange): Promise<DbWealthDatapoint[]> {
  const now = Date.now();
  if (range === 'all') return window.electronAPI.db.wealth.getRange(0, now);
  return window.electronAPI.db.wealth.getRange(now - RANGE_MS[range], now);
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
    const {range} = get();
    const [points, latest] = await Promise.all([fetchPoints(range), fetchLatest()]);
    const {breakdown, latestTimestamp} = parseBreakdown(latest);
    set({datapoints: points, latestBreakdown: breakdown, latestTimestamp, isLoaded: true});
  },

  refresh: async () => {
    const {range} = get();
    const [points, latest] = await Promise.all([fetchPoints(range), fetchLatest()]);
    const {breakdown, latestTimestamp} = parseBreakdown(latest);
    set({datapoints: points, latestBreakdown: breakdown, latestTimestamp});
  },

  setRange: async (range) => {
    set({range});
    const points = await fetchPoints(range);
    set({datapoints: points});
  },
}));
