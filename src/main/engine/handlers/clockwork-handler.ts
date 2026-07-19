import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * ClockworkHandler — Clockwork Ballet (S7) translator.
 *
 *   s7_success / s7_fail : voucher turn-in concluded; start tracker + arm loot
 *                          window. Ignored if a loot window is already active
 *                          (duplicate end signals).
 *   bag_update           : decaying refresh while the loot window is active.
 *   zone_transition (town): handled centrally by ZoneHandler.finishAll.
 */
export class ClockworkHandler implements EventHandler {
  readonly name    = 'clockwork';
  readonly handles = ['s7_success', 's7_fail', 'bag_update'] as const;

  private _lootMs: number = DEFAULT_LOOT_COLLECTION_MS;

  setLootDurationMs(ms: number): void {
    this._lootMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Fully paused-guarded: all crediting / loot-timer events. Teardown is via
    // ZoneHandler.finishAll on town entry (runs while paused).
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 's7_success':
      case 's7_fail': {
        if (ctx.registry.seasonal('clockwork')?.isLootCollecting()) return;
        const t = ctx.registry.startSeasonal({type: 'clockwork', lootDurationMs: this._lootMs}, emit);
        t?.armLootTimer();
        break;
      }
      case 'bag_update':
        ctx.registry.seasonal('clockwork')?.refreshLootTimer();
        break;
    }
  }
}
