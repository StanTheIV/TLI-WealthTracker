import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import type {LootCollectionTimer} from '@/main/engine/loot-collection-timer';
import {
  startSeasonal,
  finishOnTownEntry,
  createLootTimer,
  startLootTimer,
  refreshLootTimer,
  cancelLootTimer,
} from './seasonal-helpers';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * OverrealmHandler — manages the Overrealm (S12) seasonal tracker lifecycle.
 *
 * Event flow:
 *   s12_entry       : USceneEffectMgr::S12SwitchFinish — fires on every
 *                     Overrealm pact switch (initial entry, each inner stage
 *                     transition, AND the exit transition itself).
 *                     - When outside Overrealm → start tracker.
 *                     - When inside Overrealm  → ignore (stage transition).
 *                     - When in loot window    → cancel timer, resume session
 *                                                (player re-entered a new
 *                                                 Overrealm portal in the same
 *                                                 map).
 *   s12_exit        : gameplay type 8001 received notifyId 101 — fires when
 *                     the Overrealm pact deactivates and the player is back
 *                     in the Netherrealm. Arms the LootCollectionTimer.
 *   bag_update      : refreshes the loot timer on each item pickup.
 *   zone_transition : entering town cancels the loot timer and finishes
 *                     immediately (existing seasonal-helpers behavior).
 *
 * Loot collection: after the s12_exit signal, drops in the next 5s attribute
 * to the Overrealm tracker. Each pickup refreshes the timer to 80% of total
 * duration whenever remaining time drops below that threshold.
 *
 * Must be registered AFTER ZoneHandler and BEFORE ItemHandler.
 */
export class OverrealmHandler implements EventHandler {
  readonly name    = 'overrealm';
  readonly handles = ['s12_entry', 's12_exit', 'zone_transition', 'bag_update'] as const;

  private _lootTimer:      LootCollectionTimer | null = null;
  private _lootDurationMs: number                     = DEFAULT_LOOT_COLLECTION_MS;
  // True between s12_entry and s12_exit: the player is in Overrealm proper
  // (not yet in the post-exit loot window).
  private _inOverrealm: boolean = false;

  /** Test-only: is the player currently inside the Overrealm stages? */
  isInOverrealm(): boolean { return this._inOverrealm; }
  /** Test-only: is the post-exit loot collection timer running? */
  isLootCollecting(): boolean { return this._lootTimer?.active ?? false; }

  /** Update the post-exit loot window in milliseconds. Takes effect on the
   *  next exit (the in-flight timer, if any, keeps its original duration). */
  setLootDurationMs(ms: number): void {
    const next = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
    this._lootDurationMs = next;
  }

  onStop(_ctx: EngineContext): void {
    this._lootTimer?.cancel();
    this._lootTimer   = null;
    this._inOverrealm = false;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    switch (event.type) {
      case 's12_entry':
        this._handleEntry(ctx, emit);
        break;

      case 's12_exit':
        this._handleExit(ctx, emit);
        break;

      case 'zone_transition':
        if (finishOnTownEntry(event.toScene, this._lootTimer, ctx, emit, 'overrealm')) {
          this._lootTimer = null;
        }
        break;

      case 'bag_update':
        if (this._lootTimer) refreshLootTimer(this._lootTimer, 'overrealm', emit);
        break;
    }
  }

  private _handleEntry(ctx: EngineContext, emit: EmitFn): void {
    // Re-entry while loot timer is running — player took another Overrealm
    // portal in the same map. Cancel the timer and resume the session.
    if (this._lootTimer?.active) {
      cancelLootTimer(this._lootTimer, 'overrealm', emit);
      this._lootTimer   = null;
      this._inOverrealm = true;
      return;
    }

    // Already inside (stage 2/3/4 transition) — ignore.
    if (this._inOverrealm) return;

    // First entry — start the tracker.
    this._inOverrealm = true;
    startSeasonal('overrealm', ctx, emit);
  }

  private _handleExit(ctx: EngineContext, emit: EmitFn): void {
    // Defensive: only act if we believe we're inside Overrealm. A spurious
    // s12_exit (e.g. engine started mid-Overrealm and missed the entry)
    // is ignored.
    if (!this._inOverrealm) return;
    this._inOverrealm = false;
    this._lootTimer = createLootTimer(this._lootDurationMs, 'overrealm', ctx, emit, () => {
      this._lootTimer = null;
    });
    startLootTimer(this._lootTimer, 'overrealm', emit);
  }
}
