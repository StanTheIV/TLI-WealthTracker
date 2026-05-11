import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * CarjackHandler — Carjack (S11) translator.
 *
 *   s11_start  : start tracker (idempotent — registry.startSeasonal handles dup).
 *   s11_end    : arm post-combat loot timer if a tracker exists and isn't
 *                already in a loot window (defensive against duplicate end lines).
 *   bag_update : decaying refresh while a loot window is active.
 *   zone_transition (town): handled centrally by ZoneHandler.finishAll.
 */
export class CarjackHandler implements EventHandler {
  readonly name    = 'carjack';
  readonly handles = ['s11_start', 's11_end', 'bag_update'] as const;

  private _lootMs: number = DEFAULT_LOOT_COLLECTION_MS;

  setLootDurationMs(ms: number): void {
    this._lootMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 's11_start':
        ctx.registry.startSeasonal({type: 'carjack', lootDurationMs: this._lootMs}, emit);
        break;
      case 's11_end': {
        const t = ctx.registry.seasonal('carjack');
        if (t && !t.isLootCollecting()) t.armLootTimer();
        break;
      }
      case 'bag_update':
        ctx.registry.seasonal('carjack')?.refreshLootTimer();
        break;
    }
  }
}
