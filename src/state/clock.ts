/**
 * The renderer's one display clock: a cached `now` that every live timer
 * (session/map/seasonal elapsed, loot-window countdowns) reads, ticking at
 * 4 Hz. Rows don't own timers — they subscribe here, so N live rows cost one
 * `setTimeout`, and nothing ticks while nothing is subscribed.
 *
 * Each tick is a `setTimeout` to the next 250 ms wall boundary rather than a
 * `setInterval`: a late tick (throttled hidden window, sleep) re-aligns
 * instead of drifting. Shaped for `useSyncExternalStore` (see `useNow`).
 */

export const TICK_MS = 250;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  timer = setTimeout(tick, TICK_MS - (Date.now() % TICK_MS));
}

function stop(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function refresh(): void {
  now = Date.now();
  // A copy: a listener may unsubscribe (unmount) while being notified. One that
  // throws must neither skip the rest nor escape the tick.
  for (const l of [...listeners]) {
    try {
      l();
    } catch (err) {
      console.error('[clock] listener threw:', err);
    }
  }
}

function tick(): void {
  timer = null;
  refresh();
  if (listeners.size > 0 && timer === null) schedule();
}

/** Start ticking on the first subscriber (refreshing `now` synchronously so
 *  it doesn't carry the value from when the clock last stopped); stop on the
 *  last unsubscribe. Safe for StrictMode's subscribe/unsubscribe/subscribe. */
export function subscribe(cb: () => void): () => void {
  // One entry per subscription, so subscribing the same `cb` twice and a
  // repeated unsubscribe stay independent.
  const entry = () => cb();
  listeners.add(entry);
  if (listeners.size === 1 && timer === null) {
    now = Date.now();
    schedule();
  }
  return () => {
    if (listeners.delete(entry) && listeners.size === 0) stop();
  };
}

/** The cached `now` — stable between ticks. While stopped (no subscriber) it
 *  is caught up lazily, at most once per tick period, so a render that
 *  precedes its first subscribe never reads a long-stale value. */
export function getSnapshot(): number {
  if (timer === null) {
    const t = Date.now();
    if (t - now >= TICK_MS) now = t;
  }
  return now;
}

// A hidden window throttles timers to ≥ 1 s; becoming visible again catches
// up at once and re-aligns the tick. No `document` in Node tests.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || listeners.size === 0) return;
    stop();
    tick();
  });
}

// -- display math -------------------------------------------------------------

/** The elapsed a tracker DISPLAYS at `now`: a running tracker's snapshot
 *  extrapolated from when it arrived, a frozen one's as is. The clamp covers a
 *  snapshot that arrived after the clock's last tick. */
export function elapsedAt(
  snapshotElapsed: number,
  receivedAt: number | null,
  now: number,
  running: boolean,
): number {
  return running && receivedAt !== null ? snapshotElapsed + Math.max(0, now - receivedAt) : snapshotElapsed;
}

/** Whole seconds left until `deadline` (absolute ms epoch), rounded up; null
 *  when there is no deadline or it has passed. */
export function countdownSec(deadline: number | null, now: number): number | null {
  if (deadline === null) return null;
  const remaining = deadline - now;
  return remaining <= 0 ? null : Math.ceil(remaining / 1000);
}
