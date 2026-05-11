import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

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
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 's13_start': {
        const existing = ctx.registry.seasonal('vorex');
        if (existing && !existing.active) existing.resumeTracker();
        else                              ctx.registry.startSeasonal({type: 'vorex'}, emit);
        break;
      }
      case 's13_window_close':
        ctx.registry.seasonal('vorex')?.pauseTracker();
        break;
      case 's13_abandon':
        this._abandoning = true;
        break;
      case 'zone_transition':
        if (this._abandoning) {
          this._abandoning = false;
          if (event.toScene.includes(VOREX_REWARD_ZONE)) {
            const existing = ctx.registry.seasonal('vorex');
            if (existing) existing.resumeTracker();
            else          ctx.registry.startSeasonal({type: 'vorex'}, emit);
          } else {
            ctx.registry.seasonal('vorex')?.finish();
          }
        }
        break;
    }
  }
}
