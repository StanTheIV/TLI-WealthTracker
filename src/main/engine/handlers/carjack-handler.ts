import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {LootCollectionTimer} from '@/main/engine/loot-collection-timer';
import {startSeasonal, finishSeasonal} from './seasonal-helpers';

const LOOT_COLLECTION_MS = 5_000;
const TOWN_MARKER        = 'YuJinZhiXiBiNanSuo';

/**
 * CarjackHandler — manages the Carjack (S11) seasonal tracker lifecycle.
 *
 * Event flow:
 *   s11_start       : Play_Mus_Gameplay_S11_Robbery_Full — combat music starts
 *                     Fires for both regular and bounty carjack variants.
 *   s11_end         : Stop_Mus_Gameplay_S11_Robbery_Full — timer expired, combat ends
 *   bag_update      : refreshes the loot timer on each item pickup
 *   zone_transition : entering town cancels loot timer and finishes immediately
 *
 * After the combat timer expires, a LootCollectionTimer keeps the tracker alive
 * for post-combat loot attribution (same pattern as Overrealm).
 *
 * Must be registered AFTER ZoneHandler and BEFORE ItemHandler.
 */
export class CarjackHandler implements EventHandler {
  readonly name    = 'carjack';
  readonly handles = ['s11_start', 's11_end', 'zone_transition', 'bag_update'] as const;

  private _lootTimer: LootCollectionTimer | null = null;
  // Private de-dup guard for repeated s11_start lines — handler-local on
  // purpose. Unlike OverrealmHandler's flags on EngineContext (read across
  // event types), this is only consulted inside this handler.
  private _inCarjack: boolean = false;

  onStop(_ctx: EngineContext): void {
    this._lootTimer?.cancel();
    this._lootTimer = null;
    this._inCarjack = false;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    switch (event.type) {
      case 's11_start':
        this._handleStart(ctx, emit);
        break;

      case 's11_end':
        this._handleEnd(ctx, emit);
        break;

      case 'zone_transition':
        this._handleZoneTransition(event.toScene, ctx, emit);
        break;

      case 'bag_update':
        this._lootTimer?.refresh();
        break;
    }
  }

  private _handleStart(ctx: EngineContext, emit: EmitFn): void {
    // Duplicate log line or already active — ignore.
    if (this._inCarjack) return;

    this._inCarjack = true;
    startSeasonal('carjack', ctx, emit);
  }

  private _handleEnd(ctx: EngineContext, emit: EmitFn): void {
    // Duplicate log line or not in carjack — ignore.
    if (!this._inCarjack) return;

    this._inCarjack = false;
    this._startLootTimer(ctx, emit);
  }

  private _handleZoneTransition(toScene: string, ctx: EngineContext, emit: EmitFn): void {
    // Entering town while loot timer is active — stop immediately.
    if (toScene.includes(TOWN_MARKER) && this._lootTimer?.active) {
      this._lootTimer.cancel();
      this._lootTimer = null;
      finishSeasonal(ctx, emit);
    }
  }

  private _startLootTimer(ctx: EngineContext, emit: EmitFn): void {
    this._lootTimer = new LootCollectionTimer(LOOT_COLLECTION_MS, () => {
      this._lootTimer = null;
      finishSeasonal(ctx, emit);
    });
    this._lootTimer.start();
  }
}
