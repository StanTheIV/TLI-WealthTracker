/** Floor for the decaying pickup-refresh — the geometric shrinkage stops here
 *  so the loot window never collapses to a sliver that's effectively useless. */
const MIN_REFRESH_MS = 1_000;

/**
 * LootCollectionTimer — keeps a seasonal tracker alive during post-exit looting.
 *
 * When a seasonal mechanic ends (e.g. Overrealm), the player returns to the map
 * and loots the items that dropped inside. This timer extends attribution of
 * those drops to the seasonal tracker for a configurable window.
 *
 * Two refresh modes:
 *  - `refresh()` (pickups): re-arms the timer to 80% of the *current* window
 *    when the remaining time has fallen below that 80% threshold, with a
 *    `MIN_REFRESH_MS` floor. The window shrinks geometrically on each
 *    successive pickup (5000ms → 4000ms → 3200ms → ...) but stops decaying
 *    at the floor. This makes long camp sessions wind down naturally without
 *    collapsing to an unusable sliver.
 *  - `reset()` (strums / encounter re-engagement): unconditionally re-arms back
 *    to the full configured `durationMs`, undoing any decay so the player gets
 *    a fresh full window when they re-engage the mechanic.
 *
 * Reusable for any seasonal mechanic that needs post-exit loot attribution.
 */
export class LootCollectionTimer {
  private _timer:     ReturnType<typeof setTimeout> | null = null;
  private _startedAt: number = 0;
  // The currently scheduled wait — equals durationMs after start()/reset(),
  // shrinks to 80% of itself on each refresh() that actually re-arms.
  private _currentDurationMs: number = 0;
  private _onExpire:  () => void;

  readonly durationMs: number;

  constructor(durationMs: number, onExpire: () => void) {
    this.durationMs = durationMs;
    this._onExpire  = onExpire;
  }

  get active(): boolean {
    return this._timer !== null;
  }

  start(): void {
    this._arm(this.durationMs);
  }

  /**
   * Returns the timestamp at which the timer is currently scheduled to fire,
   * or null when not active. Useful for surfacing a live countdown.
   */
  get deadline(): number | null {
    if (!this.active) return null;
    return this._startedAt + this._currentDurationMs;
  }

  /**
   * Pickup refresh — shrinks the next window to 80% of the current one when
   * remaining time has dropped below 80% of it. Returns true when the timer
   * was actually re-armed (so callers can publish a new deadline), false
   * when the pickup didn't trigger a reset (still plenty of time left).
   */
  refresh(): boolean {
    if (!this.active) return false;

    const remaining = this._currentDurationMs - (Date.now() - this._startedAt);
    const next      = Math.max(this._currentDurationMs * 0.8, MIN_REFRESH_MS);

    // Re-arm when remaining has fallen below the next step. At the floor
    // (current = next = MIN_REFRESH_MS), `remaining < next` reduces to
    // `remaining < current`, which is true any time after t=0 — so a player
    // picking up loot continuously inside the 1s floored window keeps
    // extending it. That's the intent: the floor is the smallest window,
    // not the end of the timer.
    if (remaining < next) {
      this._arm(next);
      return true;
    }
    return false;
  }

  /**
   * Strum / re-engagement reset — unconditionally re-arms to the full configured
   * window, undoing any decay accumulated by previous pickup-refreshes.
   */
  reset(): void {
    this._arm(this.durationMs);
  }

  cancel(): void {
    this._clear();
  }

  private _arm(ms: number): void {
    this._clear();
    this._startedAt          = Date.now();
    this._currentDurationMs  = ms;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._onExpire();
    }, ms);
  }

  private _clear(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
