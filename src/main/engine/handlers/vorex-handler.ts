import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {pauseMapForInterlude, resolveMapInterlude} from '@/main/engine/map-interlude';

const VOREX_REWARD_ZONE = 'DiXiaZhenSuo';

/**
 * VorexHandler — Vorex (S13) translator.
 *
 *   s13_start        : start (or resume if paused) tracker
 *   s13_window_close : pause tracker
 *   s13_abandon      : flag; resolved on next zone_transition
 *   zone_transition  : if abandoning, finish (or resume + reward zone)
 */
export class VorexHandler implements EventHandler {
  readonly name    = 'vorex';
  readonly handles = ['s13_start', 's13_window_close', 's13_abandon', 'zone_transition'] as const;

  // s13_abandon seen; waiting for zone_transition to resolve.
  private _abandoning = false;

  onStop(): void {
    this._abandoning = false;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;

    switch (event.type) {
      // Crediting starts / self-pause — inert while the session is paused.
      case 's13_start': {
        if (ctx.paused) break;
        // The Vorex window is a panel interlude — a running map freezes while
        // it's open (opened mid-map after gathering organs; no-op from town).
        pauseMapForInterlude(ctx, emit);
        ctx.registry.activateSeasonal({type: 'vorex'}, emit);
        break;
      }
      case 's13_window_close':
        // Structural: the window IS closed — the player is back on the map.
        resolveMapInterlude(ctx, emit);
        if (ctx.paused) break;
        ctx.registry.seasonal('vorex')?.pauseTracker();
        break;
      // Flag flip (safe while paused) + structural map bookkeeping: the vorex
      // UI is fully gone until the follow-up zone_transition resolves it.
      case 's13_abandon':
        this._abandoning = true;
        resolveMapInterlude(ctx, emit);
        break;
      case 'zone_transition': {
        // The fight/loot zone (DiXiaZhenSuo) is part of the interlude:
        // entering it from a map re-freezes the map (the commit sequence fires
        // window_close + abandon just before zoning, briefly resuming it);
        // the exit always goes to town, where ZoneHandler has already finished
        // the map off its frozen elapsed — resolve just clears the marker.
        const enteringFight = !event.fromScene.includes(VOREX_REWARD_ZONE) && event.toScene.includes(VOREX_REWARD_ZONE);
        const leavingFight  = event.fromScene.includes(VOREX_REWARD_ZONE) && !event.toScene.includes(VOREX_REWARD_ZONE);
        if (enteringFight)     pauseMapForInterlude(ctx, emit);
        else if (leavingFight) resolveMapInterlude(ctx, emit);

        // Structural resolution of an abandon. The FINISH path must run even
        // while paused so an abandoned run doesn't hang. The reward-zone branch
        // is a crediting resume/start, so it's suppressed while paused (the flag
        // is consumed either way — on resume a fresh s13_start re-enters).
        if (this._abandoning) {
          this._abandoning = false;
          if (event.toScene.includes(VOREX_REWARD_ZONE)) {
            if (ctx.paused) break;
            ctx.registry.activateSeasonal({type: 'vorex'}, emit);
          } else {
            ctx.registry.seasonal('vorex')?.finish();
          }
        }
        break;
      }
    }
  }
}
