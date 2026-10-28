import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {mechanic, windowMs} from '@/shared/mechanics';

const MECHANIC = mechanic('lunaria');

/**
 * LunariaHandler — Lunaria (S14 "MingYue") translator.
 *
 * Multiple strums in one map fold into the same tracker; the loot timer pauses
 * the tracker on expiry instead of finishing it (`pauseOnLootExpiry: true`).
 *   s14_strum (first) : start tracker + arm loot timer
 *   s14_strum (later) : reset loot timer (full window, undoes decay; wakes a
 *                       paused tracker — TrackerRegistry.wakeForLoot)
 *   bag_update        : decaying refresh of the loot timer (never wakes)
 */
export class LunariaHandler implements EventHandler {
  readonly name    = 'lunaria';
  readonly handles = ['s14_strum', 'bag_update'] as const;

  private _lootMs: number = MECHANIC.window.defaultMs;

  configure(settings: Readonly<Record<string, string>>): void {
    this._lootMs = windowMs(settings, MECHANIC);
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Fully paused-guarded: strum starts/resumes/resets and loot-timer refreshes
    // are all crediting. Lunaria's OWN self-pause (loot expiry between strums)
    // must survive a session resume — the engine only resumes seasonals IT
    // paused, so a Lunaria that was self-paused stays paused. Teardown is via
    // ZoneHandler.finishAll on town entry (runs while paused).
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

    // Strum is re-engagement: full reset undoes any pickup-decay so the player
    // gets a fresh full window, and wakes a tracker parked between strums.
    existing.resetLootTimer();
  }
}
