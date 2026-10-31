import {countdownSec} from '@/state/clock';
import {useNow} from './useNow';

/**
 * Returns the integer seconds remaining until `deadline` (an absolute ms
 * epoch), ticking down on the shared 4 Hz clock. Returns null when
 * `deadline` is null or already passed. Used to render the seasonal
 * loot-window countdown next to the tracker label.
 */
export function useLootWindowCountdown(deadline: number | null): number | null {
  const now = useNow(deadline !== null);
  return countdownSec(deadline, now);
}
