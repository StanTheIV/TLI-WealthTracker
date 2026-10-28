import {elapsedAt} from '@/state/clock';
import {useNow} from './useNow';

/**
 * Returns a live-updating elapsed time for a tracker whose snapshot is
 * only updated on engine events (not continuously).
 *
 * Extrapolates snapshotElapsed from receivedAt on the shared 4 Hz clock.
 * When not running, returns snapshotElapsed as-is.
 */
export function useTrackerElapsed(
  snapshotElapsed: number,
  receivedAt: number | null,
  isRunning: boolean,
): number {
  const now = useNow(isRunning && receivedAt !== null);
  return elapsedAt(snapshotElapsed, receivedAt, now, isRunning);
}
