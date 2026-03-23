/**
 * LootCollectionTimer — keeps a seasonal tracker alive during post-exit looting.
 *
 * When a seasonal mechanic ends (e.g. Overrealm), the player returns to the map
 * and loots the items that dropped inside. This timer extends attribution of those
 * drops to the seasonal tracker for a configurable window.
 *
 * Each item pickup refreshes the timer, but only if remaining time has dropped
 * below 80% of the total duration. This prevents the timer from being reset
 * indefinitely while still giving a generous window for each loot pickup.
 *
 * Reusable for any seasonal mechanic that needs post-exit loot attribution.
 */
export class LootCollectionTimer {
  private _timer:     ReturnType<typeof setTimeout> | null = null;
  private _startedAt: number = 0;
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
    this._clear();
    this._startedAt = Date.now();
    this._timer = setTimeout(() => {
      this._timer = null;
      this._onExpire();
    }, this.durationMs);
  }

  /**
   * Called on each item pickup during the loot window.
   * Resets the timer to 80% of total duration only if remaining time has
   * already fallen below that threshold — avoids infinite extension.
   */
  refresh(): void {
    if (!this.active) return;

    const remaining  = this.durationMs - (Date.now() - this._startedAt);
    const threshold  = this.durationMs * 0.8;

    if (remaining < threshold) {
      this._clear();
      this._startedAt = Date.now();
      this._timer = setTimeout(() => {
        this._timer = null;
        this._onExpire();
      }, threshold);
    }
  }

  cancel(): void {
    this._clear();
  }

  private _clear(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
