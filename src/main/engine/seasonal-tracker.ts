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

  constructor(opts: {
    registry:           TrackerRegistry;
    emit:               EmitFn;
    type:               SeasonalType;
    ownsBubble?:        boolean;
    phase?:             SeasonalPhase;
    lootDurationMs?:    number;
    pauseOnLootExpiry?: boolean;
  }) {
    super('seasonal', opts.type, opts.ownsBubble ?? false);
    this.seasonalType       = opts.type;
    this.ownsBubble         = opts.ownsBubble ?? false;
    this.phase              = opts.phase;
    this._registry          = opts.registry;
    this._emit              = opts.emit;
    this._lootDurationMs    = opts.lootDurationMs ?? 5_000;
    this._pauseOnLootExpiry = opts.pauseOnLootExpiry ?? false;
  }

  // -------------------------------------------------------------------------
  // Loot timer API — handlers call these
  // -------------------------------------------------------------------------

  /** Arm a fresh post-mechanic loot window. Cancels any in-flight timer. */
  armLootTimer(): void {
    this._lootTimer?.cancel();
    this._lootTimer = new LootCollectionTimer(this._lootDurationMs, () => this._onLootExpire());
    this._lootTimer.start();
    const deadline = this._lootTimer.deadline ?? Date.now() + this._lootDurationMs;
    this._emit({type: 'loot_window_started', seasonalType: this.seasonalType, deadline, timestamp: Date.now()});
  }

  /** Pickup-driven refresh — decaying 80% rule with 1s floor. */
  refreshLootTimer(): void {
    if (!this._lootTimer) return;
    if (this._lootTimer.refresh()) {
      const deadline = this._lootTimer.deadline ?? Date.now();
      this._emit({type: 'loot_window_started', seasonalType: this.seasonalType, deadline, timestamp: Date.now()});
    }
  }

  /** Strum-driven reset — full re-arm, undoes any decay. */
  resetLootTimer(): void {
    if (!this._lootTimer) {
      this.armLootTimer();
      return;
    }
    this._lootTimer.reset();
    const deadline = this._lootTimer.deadline ?? Date.now() + this._lootDurationMs;
    this._emit({type: 'loot_window_started', seasonalType: this.seasonalType, deadline, timestamp: Date.now()});
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
