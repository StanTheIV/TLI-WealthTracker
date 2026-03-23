import {create} from 'zustand';
import type {DbWealthDatapoint} from '@/types/electron';

export interface BreakdownEntry {
  qty:   number;
  price: number;
  total: number;
}

export type Breakdown = Record<string, BreakdownEntry>;

interface WealthState {
  datapoints:      DbWealthDatapoint[];
  latestBreakdown: Breakdown;
  latestTimestamp: number | null;
  isLoaded:        boolean;
}

interface WealthActions {
  load:    () => Promise<void>;
  refresh: () => Promise<void>;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function parseLatest(points: DbWealthDatapoint[]): {breakdown: Breakdown; latestTimestamp: number | null} {
  if (points.length === 0) return {breakdown: {}, latestTimestamp: null};
  const latest = points[points.length - 1];
  try {
    return {breakdown: JSON.parse(latest.breakdown) as Breakdown, latestTimestamp: latest.timestamp};
  } catch {
    return {breakdown: {}, latestTimestamp: latest.timestamp};
  }
}

async function fetchPoints(): Promise<DbWealthDatapoint[]> {
  const now  = Date.now();
  const from = now - THIRTY_DAYS_MS;
  return window.electronAPI.db.wealth.getRange(from, now);
}

export const useWealthStore = create<WealthState & WealthActions>((set) => ({
  datapoints:      [],
  latestBreakdown: {},
  latestTimestamp: null,
  isLoaded:        false,

  load: async () => {
    const points = await fetchPoints();
    const {breakdown, latestTimestamp} = parseLatest(points);
    set({datapoints: points, latestBreakdown: breakdown, latestTimestamp, isLoaded: true});
  },

  refresh: async () => {
    const points = await fetchPoints();
    const {breakdown, latestTimestamp} = parseLatest(points);
    set({datapoints: points, latestBreakdown: breakdown, latestTimestamp});
  },
}));
