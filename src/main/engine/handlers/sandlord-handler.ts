import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

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
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    const enteringHub  = event.toScene.includes(SANDLORD_HUB_MARKER);
    const enteringTown = event.toScene.includes(TOWN_MARKER);
    const inSandlord   = ctx.registry.seasonal('sandlord') !== null;

    if (enteringHub && !inSandlord) {
      ctx.registry.startSeasonal({type: 'sandlord', ownsBubble: true}, emit);
      return;
    }

    if (inSandlord && enteringTown) {
      ctx.registry.seasonal('sandlord')?.finish();
    }
  }
}
