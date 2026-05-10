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
 * The S12Processor hides game-log quirks (stage-transition + post-exit
 * `S12SwitchFinish` lines) so this handler only ever sees genuine entries:
 *
 *   s12_entry       : start tracker; if a loot timer from a previous
 *                     Overrealm in this same map is still running, cancel
 *                     it (player took another portal — same tracker
 *                     continues until town).
 *   s12_exit        : arm the loot collection timer.
 *   bag_update      : refresh the loot timer (decaying 80%-of-current rule).
 *   zone_transition : town entry cancels the timer and finishes the tracker.
 *   loot timer end  : finishes the tracker via createLootTimer's onExpire.
 *
 * Must be registered AFTER ZoneHandler and BEFORE ItemHandler.
 */
export class OverrealmHandler implements EventHandler {
  readonly name    = 'overrealm';
  readonly handles = ['s12_entry', 's12_exit', 'zone_transition', 'bag_update'] as const;

  private _lootTimer:      LootCollectionTimer | null = null;
  private _lootDurationMs: number                     = DEFAULT_LOOT_COLLECTION_MS;

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
    this._lootTimer = null;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    switch (event.type) {
      case 's12_entry':
        // Same-map re-entry while the previous loot timer is still ticking —
        // player took another portal. Cancel the timer; the existing tracker
        // continues. startSeasonal is idempotent for the same type.
        if (this._lootTimer?.active) {
          cancelLootTimer(this._lootTimer, 'overrealm', emit);
          this._lootTimer = null;
        }
        startSeasonal('overrealm', ctx, emit);
        break;

      case 's12_exit':
        this._lootTimer = createLootTimer(this._lootDurationMs, 'overrealm', ctx, emit, () => {
          this._lootTimer = null;
        });
        startLootTimer(this._lootTimer, 'overrealm', emit);
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
}
