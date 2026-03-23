import {useEffect, useState} from 'react';

/**
 * Returns a live-updating elapsed time for a tracker whose snapshot is
 * only updated on engine events (not continuously).
 *
 * Extrapolates by computing snapshotElapsed + (now - receivedAt) at 10 Hz.
 * When not running, returns snapshotElapsed as-is.
 */
export function useTrackerElapsed(
  snapshotElapsed: number,
  receivedAt: number | null,
  isRunning: boolean,
): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning || receivedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [isRunning, receivedAt]);

  if (!isRunning || receivedAt === null) return snapshotElapsed;
  return snapshotElapsed + (now - receivedAt);
}
