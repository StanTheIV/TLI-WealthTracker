import {useEffect, useState} from 'react';

/**
 * Returns the integer seconds remaining until `deadline` (an absolute ms
 * epoch), ticking down at 5 Hz. Returns null when `deadline` is null or
 * already passed. Used to render the seasonal loot-window countdown next
 * to the tracker label.
 */
export function useLootWindowCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now()); // sync immediately so the first paint is correct
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline === null) return null;
  const remaining = deadline - now;
  if (remaining <= 0) return null;
  return Math.ceil(remaining / 1000);
}
