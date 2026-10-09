import {create} from 'zustand';
import {currentLeague, leagueRanges, type League, type LeagueRange} from '@/lib/leagues';

interface LeaguesState {
  leagues: League[];
  ranges:  LeagueRange[];
  loaded:  boolean;
}

interface LeaguesActions {
  /** Fetch leagues and subscribe to leagues:changed (once). */
  load:     () => Promise<void>;
  startNow: (name?: string) => Promise<void>;
  setStart: (id: string, ts: number) => Promise<boolean>;
}

let _subscribed = false;

export const useLeaguesStore = create<LeaguesState & LeaguesActions>((set, get) => {
  const reload = async () => {
    const leagues = await window.electronAPI.db.leagues.getAll();
    set({leagues, ranges: leagueRanges(leagues), loaded: true});
  };

  return {
    leagues: [],
    ranges:  [],
    loaded:  false,

    load: async () => {
      if (!_subscribed) {
        _subscribed = true;
        window.electronAPI.db.leagues.onChanged(() => { void get().load(); });
      }
      await reload();
    },

    // State refreshes via the leagues:changed broadcast.
    startNow: async (name) => { await window.electronAPI.db.leagues.startNow(name); },
    setStart: (id, ts)     => window.electronAPI.db.leagues.setStart(id, ts),
  };
});

/** Range containing "now"; computed on render. */
export function useCurrentLeague(): LeagueRange | undefined {
  const ranges = useLeaguesStore(s => s.ranges);
  return currentLeague(ranges, Date.now());
}
