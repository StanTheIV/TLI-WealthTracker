import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {pauseMapForInterlude, resolveMapInterlude} from '@/main/engine/map-interlude';

const SANDLORD_HUB_MARKER = 'YunDuanLvZhou';
const TOWN_MARKER         = 'YuJinZhiXiBiNanSuo';

/**
 * SandlordHandler — Sandlord (S10) translator.
 *
 * Pure zone-transition trigger. Entering the seasonal hub starts a bubble
 * seasonal that absorbs hub + sub-maps into one tracker (no per-map trackers
 * are created inside; ZoneHandler reads `registry.hasBubble()` and skips).
 *
 * Must be registered BEFORE ZoneHandler so the bubble is in the registry by
 * the time Zone runs on the same event.
 */
export class SandlordHandler implements EventHandler {
  readonly name    = 'sandlord';
  readonly handles = ['zone_transition'] as const;

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'zone_transition') return;
    if (ctx.phase !== 'tracking') return;

    const enteringHub  = event.toScene.includes(SANDLORD_HUB_MARKER);
    const enteringTown = event.toScene.includes(TOWN_MARKER);
    const inSandlord   = ctx.registry.seasonal('sandlord') !== null;

    // Entering the hub starts a bubble seasonal — a crediting start, inert while
    // paused so it doesn't spin up and begin accruing during the pause. A direct
    // map → hub transition is possible: the running map freezes for the whole
    // Sandlord run (it ends at town with the Sandlord time excluded).
    if (enteringHub && !inSandlord) {
      if (ctx.paused) return;
      pauseMapForInterlude(ctx, emit);
      ctx.registry.startSeasonal({type: 'sandlord', ownsBubble: true}, emit);
      return;
    }

    // Entering town finishes the bubble — structural teardown, must run while
    // paused so the run doesn't hang (mirrors ZoneHandler's town-entry teardown,
    // which for the bubble case is skipped because ctx.inMap is false). Also
    // resolves a map→hub interlude; ZoneHandler (registered after us) then
    // finishes that map off its frozen elapsed... unless it was resumed here a
    // tick earlier — same timestamp, zero accrual, harmless either way.
    if (inSandlord && enteringTown) {
      resolveMapInterlude(ctx, emit);
      ctx.registry.seasonal('sandlord')?.finish();
    }
  }
}
