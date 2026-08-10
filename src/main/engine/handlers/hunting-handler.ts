import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * HuntingHandler — Hunting ("SixGod") translator.
 *
 * A statue at map end spawns the boss arena. The statue ALONE never starts the
 * tracker: it only arms, and the boss-start line commits. The arena has no zone
 * transition of its own, so an armed statue the player walks away from would
 * otherwise leave a phantom run open.
 *   hunting_statue     : arm (no tracker yet)
 *   hunting_boss_start : armed → start the tracker, disarm
 *   hunting_boss_end   : arm the post-kill loot window
 *   bag_update         : decaying refresh while a loot window is active
 *   zone_transition    : disarm — leaving the scene abandons the arm
 *
 * In-map mechanic: the map keeps running and drops fall through.
 */
export class HuntingHandler implements EventHandler {
  readonly name    = 'hunting';
  readonly handles = ['hunting_statue', 'hunting_boss_start', 'hunting_boss_end', 'bag_update', 'zone_transition'] as const;

  private _armed:   boolean = false;
  private _lootMs:  number  = DEFAULT_LOOT_COLLECTION_MS;

  setLootDurationMs(ms: number): void {
    this._lootMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Disarm is STRUCTURAL — it must run even while paused, ahead of the guard
    // below. A statue followed by a scene change is an abandoned arm either way.
    if (event.type === 'zone_transition') {
      this._armed = false;
      return;
    }

    // The arm is likewise consumed by boss_start even while paused — the arena
    // opened whether or not we credit it, and a swallowed open must not leave a
    // stale arm for a later BossStatus1 to commit without a statue. (Mirrors
    // VorexHandler's "flag is consumed either way" rule.)
    if (event.type === 'hunting_boss_start') {
      const armed = this._armed;
      this._armed = false;
      if (ctx.phase !== 'tracking' || ctx.paused) return;
      if (armed && ctx.inMap && !ctx.registry.hasBubble()) {
        ctx.registry.startSeasonal({type: 'hunting', lootDurationMs: this._lootMs}, emit);
      }
      return;
    }

    // Everything else is crediting. Teardown is via ZoneHandler.finishAll on
    // town entry (runs while paused).
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 'bag_update':
        ctx.registry.seasonal('hunting')?.refreshLootTimer();
        break;
      case 'hunting_statue':
        if (ctx.inMap && !ctx.registry.hasBubble()) this._armed = true;
        break;
      case 'hunting_boss_end': {
        // The game emits BossStatus0 twice ~160ms apart; the in-flight check
        // de-dupes so the second line doesn't restart the window.
        const t = ctx.registry.seasonal('hunting');
        if (t && !t.isLootCollecting()) t.armLootTimer();
        break;
      }
    }
  }

  onStop(): void {
    this._armed = false;
  }
}
