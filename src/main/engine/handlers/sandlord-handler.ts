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
 * The "no per-map trackers inside" rule is enforced via suppressMapTracker():
 * Engine asks each handler on every map-entry zone_transition whether it
 * wants to suppress map-tracker creation. SandlordHandler answers true while
 * its bubble is active.
 *
 * Must be registered BEFORE ZoneHandler so its suppressMapTracker() answer is
 * current when ZoneHandler consults ctx.isMapSuppressed() on the same event.
 */
export class SandlordHandler implements EventHandler {
  readonly name    = 'sandlord';
  readonly handles = ['zone_transition'] as const;

  private _inSandlord = false;

  suppressMapTracker(): boolean {
    return this._inSandlord;
  }

  onStop(_ctx: EngineContext): void {
    this._inSandlord = false;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'zone_transition') return;
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    const enteringHub  = event.toScene.includes(SANDLORD_HUB_MARKER);
    const enteringTown = event.toScene.includes(TOWN_MARKER);

    if (enteringHub && !this._inSandlord) {
      this._inSandlord = true;
      startSeasonal('sandlord', ctx, emit);
      return;
    }

    if (this._inSandlord && enteringTown) {
      this._inSandlord = false;
      finishSeasonal(ctx, emit);
    }
  }
}
