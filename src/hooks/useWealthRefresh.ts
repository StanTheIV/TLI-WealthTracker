import {useEffect, useRef} from 'react';
import {useEngineStore} from '@/state/engineStore';
import {useWealthStore} from '@/state/wealthStore';

/**
 * Subscribes to the engine event feed and triggers a wealth data refresh
 * after a bag init or map end. The 500ms debounce ensures the synchronous
 * DB insert in the main process has committed before the renderer queries.
 */
export function useWealthRefresh(): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = useEngineStore.subscribe((state, prev) => {
      if (state.feed.length === prev.feed.length) return;
      const latest = state.feed[state.feed.length - 1];
      if (!latest) return;

      if (latest.event.type === 'init_complete' || latest.event.type === 'map_ended') {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          useWealthStore.getState().refresh();
        }, 500);
      }
    });

    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
}
