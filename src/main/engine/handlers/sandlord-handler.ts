import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {startSeasonal, finishSeasonal} from './seasonal-helpers';

const SANDLORD_HUB_MARKER = 'YunDuanLvZhou';
const TOWN_MARKER         = 'YuJinZhiXiBiNanSuo';

/**
 * SandlordHandler — manages the Sandlord (S10) seasonal tracker lifecycle.
 *
 * Trigger: pure zone transition, no log-line event. Entering the seasonal hub
 * (`YunDuanLvZhou`) starts the tracker; the entire bubble — hub plus its
 * sub-maps — runs as a single seasonal tracker with no per-map trackers
 * created inside. Returning to real town finishes it.
 *
 * The "no per-map trackers inside" rule is enforced by creating the seasonal
 * Tracker with `ownsBubble: true`. ZoneHandler reads `ctx.seasonal?.ownsBubble`
 * on map-entry zone_transition and skips creating a per-map tracker when it's
 * set. That's the only signal needed — no cross-handler callbacks.
 *
 * Must be registered BEFORE ZoneHandler so `ctx.seasonal` is created (and
 * `ownsBubble` is readable) before ZoneHandler runs on the same event.
 */
export class SandlordHandler implements EventHandler {
  readonly name    = 'sandlord';
  readonly handles = ['zone_transition'] as const;

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'zone_transition') return;
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    const enteringHub  = event.toScene.includes(SANDLORD_HUB_MARKER);
    const enteringTown = event.toScene.includes(TOWN_MARKER);
    const inSandlord   = ctx.seasonal?.seasonalType === 'sandlord';

    if (enteringHub && !inSandlord) {
      startSeasonal('sandlord', ctx, emit, {ownsBubble: true});
      return;
    }

    if (inSandlord && enteringTown) {
      finishSeasonal(ctx, emit);
    }
  }
}
