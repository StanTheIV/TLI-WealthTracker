import {useEffect} from 'react';
import {useEngineStore} from '@/state/engineStore';
import {useWealthStore} from '@/state/wealthStore';

/**
 * Refreshes the wealth store whenever the main process records a new
 * wealth datapoint. Main emits `wealth_recorded` after the synchronous
 * SQLite insert, so the renderer can re-fetch immediately.
 */
export function useWealthRefresh(): void {
  useEffect(() => {
    return useEngineStore.subscribe((state, prev) => {
      const latest = state.feed[state.feed.length - 1];
      if (!latest) return;
      const prevLatest = prev.feed[prev.feed.length - 1];
      if (prevLatest && latest.id === prevLatest.id) return;
      if (latest.event.type === 'wealth_recorded') {
        useWealthStore.getState().refresh();
      }
    });
  }, []);
}
