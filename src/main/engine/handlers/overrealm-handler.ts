import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {LootCollectionTimer} from '@/main/engine/loot-collection-timer';
import {startSeasonal, finishSeasonal} from './seasonal-helpers';

const LOOT_COLLECTION_MS = 5_000;
const TOWN_MARKER        = 'YuJinZhiXiBiNanSuo';

/**
 * OverrealmHandler — manages the Overrealm (S12) seasonal tracker lifecycle.
 *
 * Event flow:
 *   s12_entry          : S12SwitchFinish — fires per stage (1, 2, 3)
 *                        Only the first entry starts the tracker.
 *   map_portal_created : cfgId 52 — exit portal appeared, set exit flag
 *   zone_transition    : if exit flag set, start LootCollectionTimer
 *   bag_update         : refreshes the loot timer on each item pickup
 *   zone_transition    : entering town cancels loot timer and finishes immediately
 *
 * Loot collection: after exiting Overrealm the player loots items that dropped
 * inside. The timer stays alive per pickup, refreshing to 80% of total duration
 * whenever remaining time drops below that threshold.
 *
 * Must be registered AFTER ZoneHandler and BEFORE ItemHandler.
 */
export class OverrealmHandler implements EventHandler {
  readonly name    = 'overrealm';
  readonly handles = ['s12_entry', 'map_portal_created', 'zone_transition', 'bag_update'] as const;

  private _lootTimer: LootCollectionTimer | null = null;

  onStop(_ctx: EngineContext): void {
    this._lootTimer?.cancel();
    this._lootTimer = null;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    switch (event.type) {
      case 's12_entry':
        this._handleEntry(ctx, emit);
        break;

      case 'map_portal_created':
        // S12Processor only emits cfgId 52 — no need to re-check cfgId here.
        if (ctx.inOverrealm) ctx.overrealmExiting = true;
        break;

      case 'zone_transition':
        this._handleZoneTransition(event.toScene, ctx, emit);
        break;

      case 'bag_update':
        this._lootTimer?.refresh();
        break;
    }
  }

  private _handleEntry(ctx: EngineContext, emit: EmitFn): void {
    // Re-entered while loot timer is running — cancel timer and continue session.
    if (this._lootTimer?.active) {
      this._lootTimer.cancel();
      this._lootTimer = null;
      ctx.inOverrealm = true;
      return;
    }

    // Already inside (stage 2/3 transition) — ignore.
    if (ctx.inOverrealm) return;

    // Post-exit echo of S12SwitchFinish — ignore and clear flag.
    if (ctx.overrealmExiting) {
      ctx.overrealmExiting = false;
      return;
    }

    // First stage entry.
    ctx.inOverrealm = true;
    startSeasonal('overrealm', ctx, emit);
  }

  private _handleZoneTransition(toScene: string, ctx: EngineContext, emit: EmitFn): void {
    // Portal 52 was seen — exit to map, start loot collection window.
    if (ctx.inOverrealm && ctx.overrealmExiting) {
      ctx.inOverrealm      = false;
      ctx.overrealmExiting = false;
      this._startLootTimer(ctx, emit);
      return;
    }

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
