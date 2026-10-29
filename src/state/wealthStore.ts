import {create} from 'zustand';
import type {WealthLatestBreakdown, WealthSeriesPoint} from '@/shared/contracts/wealth';

/** The Dashboard's wealth as main values it (filter + tax applied there): the
 *  range's series and the latest reading's breakdown rows. */

export type WealthRange = '1d' | '3d' | '7d' | '1m' | 'all';

interface WealthState {
  /** The range's readings as displayed, timestamp order. */
  points:   WealthSeriesPoint[];
  latest:   WealthLatestBreakdown | null;
  range:    WealthRange;
  isLoaded: boolean;
}

interface WealthActions {
  /** Main window, once at startup: subscribes, then the first fetch. */
  load:        () => Promise<void>;
  refresh:     () => Promise<void>;
  setRange:    (range: WealthRange) => Promise<void>;
  deletePoint: (id: number) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_MS: Record<Exclude<WealthRange, 'all'>, number> = {
  '1d': 1  * DAY_MS,
  '3d': 3  * DAY_MS,
  '7d': 7  * DAY_MS,
  '1m': 30 * DAY_MS,
};

/** The oldest timestamp the range shows at `now`. */
function rangeFrom(range: WealthRange, now: number): number {
  return range === 'all' ? 0 : now - RANGE_MS[range];
}

const WEALTH_RANGE_KEY = 'wealthChartRange';
const VALID_RANGES: readonly WealthRange[] = ['1d', '3d', '7d', '1m', 'all'];

/** The chart range the user last picked, or null to keep the default — a value
 *  written by an older build that no longer exists is treated as absent. */
async function loadPersistedRange(): Promise<WealthRange | null> {
  try {
    const raw = await window.electronAPI.settings.getAll();
    const stored = raw[WEALTH_RANGE_KEY] as WealthRange | undefined;
    return stored && VALID_RANGES.includes(stored) ? stored : null;
  } catch (err) {
    console.error('[wealth] load range failed:', err);
    return null;
  }
}

/** `points` with `point` in timestamp order (replacing a reading with its id)
 *  and without the readings older than `from`. */
function withPoint(points: WealthSeriesPoint[], point: WealthSeriesPoint, from: number): WealthSeriesPoint[] {
  const next = points.filter(p => p.id !== point.id && p.ts >= from);
  if (point.ts < from) return next;
  let at = next.length;
  while (at > 0 && next[at - 1].ts > point.ts) at--;
  next.splice(at, 0, point);
  return next;
}

// A response lands only while its request is still the newest of its kind, so
// a slow 'all' answering after a quick '1d' never overwrites it. Sequenced
// apart because a recording re-reads only the latest breakdown.
let _seriesSeq = 0;
let _latestSeq = 0;
/** Readings appended while the newest series request is in flight; null when
 *  none is. Its response may predate them, so they are merged into it. */
let _appendedInFlight: WealthSeriesPoint[] | null = null;
let _subscribed = false;

export const useWealthStore = create<WealthState & WealthActions>((set, get) => {
  /** Fetches the range's series and the latest breakdown; applies each part
   *  only if no newer request for it was issued meanwhile. */
  async function fetchAll(range: WealthRange): Promise<void> {
    const seriesSeq = ++_seriesSeq;
    const latestSeq = ++_latestSeq;
    _appendedInFlight = [];
    const now = Date.now();
    const from = rangeFrom(range, now);
    let series: WealthSeriesPoint[];
    let latest: WealthLatestBreakdown | null;
    try {
      [series, latest] = await Promise.all([
        window.electronAPI.db.wealth.series(from, now),
        window.electronAPI.db.wealth.latestBreakdown(),
      ]);
    } catch (err) {
      if (seriesSeq === _seriesSeq) _appendedInFlight = null;
      throw err;
    }
    if (seriesSeq === _seriesSeq) {
      let points = series;
      for (const point of _appendedInFlight ?? []) points = withPoint(points, point, from);
      _appendedInFlight = null;
      set({points, isLoaded: true});
    }
    if (latestSeq === _latestSeq) set({latest});
  }

  async function fetchLatest(): Promise<void> {
    const seq = ++_latestSeq;
    const latest = await window.electronAPI.db.wealth.latestBreakdown();
    if (seq === _latestSeq) set({latest});
  }

  /** A new reading: main stored it before announcing it, already valued. */
  function append(point: WealthSeriesPoint): void {
    _appendedInFlight?.push(point);
    set(s => ({points: withPoint(s.points, point, rangeFrom(s.range, Date.now()))}));
    fetchLatest().catch((err: unknown) => console.error('[wealth] latest refresh failed:', err));
  }

  return {
    points:   [],
    latest:   null,
    range:    '1m',
    isLoaded: false,

    load: async () => {
      if (!_subscribed) {
        _subscribed = true;
        window.electronAPI.engine.onEvent(({event}) => {
          if (event.type === 'wealth_recorded') append(event.point);
        });
        // Filter, item type, tax setting, delete or clear: every value may move.
        window.electronAPI.db.wealth.onChanged(() => {
          get().refresh().catch((err: unknown) => console.error('[wealth] refresh failed:', err));
        });
      }
      const startSeq = _seriesSeq;
      const persisted = await loadPersistedRange();
      // A range picked while the setting was read wins over the stored one.
      if (persisted && _seriesSeq === startSeq) set({range: persisted});
      await fetchAll(get().range);
    },

    refresh: () => fetchAll(get().range),

    setRange: async (range) => {
      set({range});
      window.electronAPI.settings.set(WEALTH_RANGE_KEY, range).catch(
        (err: unknown) => console.error('[wealth] persist range failed:', err)
      );
      await fetchAll(range);
    },

    // Main announces the delete as `wealth:changed`, which refreshes — the
    // latest breakdown moves back too when the newest reading goes.
    deletePoint: async (id) => {
      await window.electronAPI.db.wealth.delete(id);
    },
  };
});
