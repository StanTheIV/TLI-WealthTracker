import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {LootCollectionTimer} from '@/main/engine/loot-collection-timer';
import {startSeasonal, finishSeasonal} from './seasonal-helpers';

const LOOT_COLLECTION_MS = 5_000;
const TOWN_MARKER        = 'YuJinZhiXiBiNanSuo';

/**
 * ClockworkHandler — manages the Clockwork Ballet (S7) seasonal tracker lifecycle.
 *
 * Drops are credited only after the voucher turn-in (marked in the log by the
 * Start → Success / FailStateItem transition). Monsters killed while collecting
 * vouchers do not count — those belong to session/map only.
 *
 * Event flow:
 *   s7_success      : HandleS7PushData Start -> Success — turn-in completed, start tracker
 *   s7_fail         : S7GamePlayFailStateItem page opens — turn-in failed, start tracker
 *   bag_update      : refreshes the loot timer on each item pickup
 *   zone_transition : entering town cancels loot timer and finishes immediately
 *
 * Tracker starts with the loot timer so post-turn-in pickups are credited
 * (same pattern as Carjack/Overrealm's post-combat loot window).
 *
 * Must be registered AFTER ZoneHandler and BEFORE ItemHandler.
 */
export class ClockworkHandler implements EventHandler {
  readonly name    = 'clockwork';
  readonly handles = ['s7_success', 's7_fail', 'zone_transition', 'bag_update'] as const;

  private _lootTimer: LootCollectionTimer | null = null;

  onStop(_ctx: EngineContext): void {
    this._lootTimer?.cancel();
    this._lootTimer = null;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    switch (event.type) {
      case 's7_success':
      case 's7_fail':
        this._handleTurnIn(ctx, emit);
        break;

      case 'zone_transition':
        this._handleZoneTransition(event.toScene, ctx, emit);
        break;

      case 'bag_update':
        this._lootTimer?.refresh();
        break;
    }
  }

  private _handleTurnIn(ctx: EngineContext, emit: EmitFn): void {
    // Already in a loot window — ignore duplicate end signals. Also protects
    // against Success and FailStateItem firing in the same game (shouldn't,
    // but cheap safety).
    if (this._lootTimer?.active) return;

    startSeasonal('clockwork', ctx, emit);
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
