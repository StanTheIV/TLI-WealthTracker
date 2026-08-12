import {Tracker} from './tracker';
import type {SeasonalPhase, SeasonalType, TrackerSnapshot} from './tracker';
import type {EmitFn} from './types';
import {LootCollectionTimer} from './loot-collection-timer';
import type {TrackerRegistry} from './tracker-registry';

/**
 * SeasonalTracker — a Tracker that owns its post-combat loot timer and
 * lifecycle. Handlers translate log events into method calls on this object;
 * everything else (timer wiring, emit fan-out, registry bookkeeping) lives
 * here.
 */
export class SeasonalTracker extends Tracker {
  readonly seasonalType: SeasonalType;
  readonly ownsBubble:   boolean;
  /** Sandlord only — 'map' coin tile vs 'hub' bubble. See SeasonalPhase. */
  readonly phase?:       SeasonalPhase;

  private _registry:          TrackerRegistry;
  private _emit:              EmitFn;
  private _lootTimer:         LootCollectionTimer | null = null;
  private _lootDurationMs:    number;
  private _pauseOnLootExpiry: boolean;
  private _lastWaveResetAt:   number = 0;
  private _claimsDrops:       boolean;

  constructor(opts: {
    registry:           TrackerRegistry;
    emit:               EmitFn;
    type:               SeasonalType;
    ownsBubble?:        boolean;
    phase?:             SeasonalPhase;
    lootDurationMs?:    number;
    pauseOnLootExpiry?: boolean;
    claimsDrops?:       boolean;
  }) {
    super('seasonal', opts.type, opts.ownsBubble ?? false);
    this.seasonalType       = opts.type;
    this.ownsBubble         = opts.ownsBubble ?? false;
    this.phase              = opts.phase;
    this._registry          = opts.registry;
    this._emit              = opts.emit;
    this._lootDurationMs    = opts.lootDurationMs ?? 5_000;
    this._pauseOnLootExpiry = opts.pauseOnLootExpiry ?? false;
    this._claimsDrops       = opts.claimsDrops ?? true;
  }

  /**
   * Whether this tracker is eligible to OWN incoming drops right now.
   *
   * Separates two things an active tracker normally conflates: that its clock
   * is running, and that it is the drop writer. A mechanic with a phase the
   * player is engaged in but which yields no loot of its own — Clockwork's
   * cogwheel fights, whose kills belong to the map — runs `claimsDrops: false`
   * so its elapsed accumulates while `writer()` skips straight past it.
   *
   * Pausing is NOT a substitute: a paused tracker stops its clock too, and
   * `Tracker.addDrop` would reject the drops the phase is supposed to time.
   */
  get claimsDrops(): boolean {
    return this._claimsDrops;
  }

  /** Flip drop eligibility. The registry's cached writer is invalidated by the
   *  caller (see TrackerRegistry.setSeasonalClaimsDrops) — changing this alone
   *  would leave a stale `_currentWriter` pointing at the wrong tracker. */
  _setClaimsDrops(v: boolean): void {
    this._claimsDrops = v;
  }

  // -------------------------------------------------------------------------
  // Loot timer API — handlers call these
  // -------------------------------------------------------------------------

  /** Arm a fresh post-mechanic loot window. Cancels any in-flight timer.
   *  Arming is gameplay engagement, so it also takes ownership — see
   *  `_takeOwnership`. */
  armLootTimer(): void {
    this._lootTimer?.cancel();
    this._lootTimer = new LootCollectionTimer(this._lootDurationMs, () => this._onLootExpire());
    this._lootTimer.start();
    const deadline = this._lootTimer.deadline ?? Date.now() + this._lootDurationMs;
    this._emit({type: 'loot_window_started', seasonalType: this.seasonalType, deadline, timestamp: Date.now()});
    this._takeOwnership();
  }

  /** Pickup-driven refresh — decaying 80% rule with 1s floor. */
  refreshLootTimer(): void {
    if (!this._lootTimer) return;
    if (this._lootTimer.refresh()) {
      const deadline = this._lootTimer.deadline ?? Date.now();
      this._emit({type: 'loot_window_started', seasonalType: this.seasonalType, deadline, timestamp: Date.now()});
    }
  }

  /** Strum/wave-driven reset — full re-arm, undoes any decay. Also takes
   *  ownership: see `_takeOwnership`. */
  resetLootTimer(): void {
    if (!this._lootTimer) {
      this.armLootTimer();
      return;
    }
    this._lootTimer.reset();
    const deadline = this._lootTimer.deadline ?? Date.now() + this._lootDurationMs;
    this._emit({type: 'loot_window_started', seasonalType: this.seasonalType, deadline, timestamp: Date.now()});
    this._takeOwnership();
  }

  /** Wave-driven reset, rate-limited: spawn bursts fire 30+ markers/sec and each
   *  reset publishes a new deadline to the overlay. Only for the ACTIVE branch —
   *  a dormant tracker has no timer to keep alive, so waking it must arm
   *  unthrottled or it resumes with no window at all.
   *
   *  Returns true when it actually re-armed, so callers can keep state that
   *  must move with the window (e.g. the expiry mode) in step with it. */
  resetLootTimerThrottled(minIntervalMs: number = 1_000): boolean {
    const now = Date.now();
    if (now - this._lastWaveResetAt < minIntervalMs) return false;
    this._lastWaveResetAt = now;
    this.resetLootTimer();
    return true;
  }

  /** The ownership rule: the seasonal whose window was most recently armed or
   *  re-armed owns the drops. Arming IS the engagement signal — the player just
   *  triggered, re-triggered or finished this mechanic — so it decides the
   *  writer, not creation order and not merely waking from dormancy. Without
   *  this a mechanic started later keeps owning loot from a fight the player has
   *  since gone back to. Skipped while inactive: a dormant tracker rejects drops
   *  anyway, and its resume path bumps the order itself. */
  private _takeOwnership(): void {
    if (!this.active || !this._claimsDrops) return;
    this._registry._onSeasonalReactivated(this, this._emit);
  }

  /** Flip expiry from park-dormant to finish-for-good. Called once when a real
   *  end marker lands: the wave window parks the tracker between waves, the end
   *  window closes the run. Must be flipped back on the next start marker —
   *  mechanics that fold a second encounter reuse the same tracker. */
  setPauseOnLootExpiry(v: boolean): void {
    this._pauseOnLootExpiry = v;
  }

  /** Retune the window length for windows armed from here on. Clockwork uses
   *  this to swap its fixed cogwheel timeout for the configured loot window at
   *  the turn-in; an in-flight timer keeps the duration it started with. */
  setLootDurationMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this._lootDurationMs = Math.floor(ms);
  }

  /** Cancel an active loot timer (e.g. on safe re-entry). Idempotent. */
  cancelLootTimer(): void {
    if (!this._lootTimer?.active) return;
    this._lootTimer.cancel();
    this._emit({type: 'loot_window_ended', seasonalType: this.seasonalType, timestamp: Date.now()});
  }

  isLootCollecting(): boolean {
    return this._lootTimer?.active ?? false;
  }

  /** Session pause: freeze an in-flight loot window (remaining time kept). */
  freezeLootTimer(): void {
    this._lootTimer?.freeze();
  }

  /** Session resume: continue a frozen loot window with its remaining time,
   *  republishing the new deadline for the overlay countdown. */
  unfreezeLootTimer(): void {
    if (this._lootTimer?.unfreeze()) {
      const deadline = this._lootTimer.deadline ?? Date.now();
      this._emit({type: 'loot_window_started', seasonalType: this.seasonalType, deadline, timestamp: Date.now()});
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle — Tracker base augmented
  // -------------------------------------------------------------------------

  snapshot(): TrackerSnapshot {
    const s = super.snapshot();
    if (this.phase) s.phase = this.phase;
    return s;
  }

  /** Finish the seasonal: cancel timer, remove from registry, emit
   *  tracker_finished. Idempotent — safe to call multiple times. */
  finish(): void {
    this._lootTimer?.cancel();
    this._lootTimer = null;
    this._registry._onSeasonalFinished(this, this._emit);
  }

  pauseTracker(): void {
    if (!this.active) return;
    this.pause();
    this._registry._onSeasonalStateChanged(this, this._emit);
  }

  /** Resume the tracker. Gameplay reactivation (default) bumps this seasonal
   *  to newest in the activation order so it becomes the drop owner; a
   *  mechanical resume (session un-pause) passes reactivate: false to restore
   *  the pre-pause ownership order untouched. */
  resumeTracker(opts?: {reactivate?: boolean}): void {
    if (this.active) return;
    this.resume();
    if (opts?.reactivate === false) this._registry._onSeasonalStateChanged(this, this._emit);
    else                            this._registry._onSeasonalReactivated(this, this._emit);
  }

  private _onLootExpire(): void {
    this._emit({type: 'loot_window_ended', seasonalType: this.seasonalType, timestamp: Date.now()});
    this._lootTimer = null;
    if (this._pauseOnLootExpiry) {
      this.pauseTracker();
    } else {
      this.finish();
    }
  }
}
