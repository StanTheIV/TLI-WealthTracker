import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * LunariaHandler — Lunaria (S14 "MingYue") translator.
 *
 * Multiple strums in one map fold into the same tracker; the loot timer pauses
 * the tracker on expiry instead of finishing it (`pauseOnLootExpiry: true`).
 *   s14_strum (first)        : start tracker + arm loot timer
 *   s14_strum (paused tracker): resume + arm fresh loot timer
 *   s14_strum (active)       : reset loot timer (full window, undoes decay)
 *   bag_update               : decaying refresh of the loot timer
 */
export class LunariaHandler implements EventHandler {
  readonly name    = 'lunaria';
  readonly handles = ['s14_strum', 'bag_update'] as const;

  private _lootMs: number = DEFAULT_LOOT_COLLECTION_MS;

  setLootDurationMs(ms: number): void {
    this._lootMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    if (event.type === 'bag_update') {
      ctx.registry.seasonal('lunaria')?.refreshLootTimer();
      return;
    }

    if (event.type !== 's14_strum') return;

    const existing = ctx.registry.seasonal('lunaria');
    if (!existing) {
      const t = ctx.registry.startSeasonal({
        type:              'lunaria',
        lootDurationMs:    this._lootMs,
        pauseOnLootExpiry: true,
      }, emit);
      t?.armLootTimer();
      return;
    }

    if (!existing.active) {
      existing.resumeTracker();
      existing.armLootTimer();
      return;
    }

    // Active tracker, in-flight timer — strum is re-engagement; full reset
    // undoes any pickup-decay so the player gets a fresh full window.
    existing.resetLootTimer();
  }
}
