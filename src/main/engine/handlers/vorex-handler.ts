import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {startSeasonal, finishSeasonal} from './seasonal-helpers';

const VOREX_REWARD_ZONE = 'DiXiaZhenSuo';

/**
 * VorexHandler — manages the Vorex (S13) seasonal tracker lifecycle.
 *
 * Event flow:
 *   s13_start        : window opened — start (or resume) tracker
 *   s13_window_close : window closed without exiting — pause tracker
 *   s13_abandon      : full exit detected — set flag, wait for zone_transition
 *   zone_transition  : resolves the abandon (completed vs abandoned)
 *     → toScene contains DiXiaZhenSuo : completed, resume for reward-zone loot
 *     → otherwise                     : abandoned, finish tracker
 *
 * Must be registered AFTER ZoneHandler and BEFORE ItemHandler.
 */
export class VorexHandler implements EventHandler {
  readonly name    = 'vorex';
  readonly handles = ['s13_start', 's13_window_close', 's13_abandon', 'zone_transition'] as const;

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    switch (event.type) {
      case 's13_start':
        if (ctx.seasonal?.seasonalType === 'vorex' && !ctx.seasonal.active) {
          // Window reopened after being closed — resume the existing tracker.
          ctx.seasonal.resume();
          emit({type: 'tracker_update', tracker: ctx.seasonal.snapshot(), timestamp: Date.now()});
        } else {
          startSeasonal('vorex', ctx, emit);
        }
        break;

      case 's13_window_close':
        if (ctx.seasonal?.seasonalType === 'vorex') {
          ctx.seasonal.pause();
          emit({type: 'tracker_update', tracker: ctx.seasonal.snapshot(), timestamp: Date.now()});
        }
        break;

      case 's13_abandon':
        ctx.vorexAbandoning = true;
        break;

      case 'zone_transition':
        if (ctx.vorexAbandoning) {
          this._resolveAbandon(event.toScene, ctx, emit);
        }
        break;
    }
  }

  private _resolveAbandon(toScene: string, ctx: EngineContext, emit: EmitFn): void {
    ctx.vorexAbandoning = false;

    if (toScene.includes(VOREX_REWARD_ZONE)) {
      // Completed — resume so reward-zone loot is attributed to Vorex.
      if (ctx.seasonal?.seasonalType === 'vorex') {
        ctx.seasonal.resume();
        emit({type: 'tracker_update', tracker: ctx.seasonal.snapshot(), timestamp: Date.now()});
      } else {
        startSeasonal('vorex', ctx, emit);
      }
    } else {
      finishSeasonal(ctx, emit);
    }
  }
}
