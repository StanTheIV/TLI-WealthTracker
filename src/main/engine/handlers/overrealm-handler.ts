import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * OverrealmHandler — translates Overrealm (S12) log events to registry / tracker
 * calls. The S12Processor hides log quirks so this handler only sees genuine
 * entries:
 *   s12_entry       : start (or re-enter — cancels any in-flight loot timer)
 *   s12_exit        : arm post-exit loot timer
 *   bag_update      : pickup-decay refresh of the loot timer
 *   zone_transition : town entry handled centrally by ZoneHandler.finishAll
 */
export class OverrealmHandler implements EventHandler {
  readonly name    = 'overrealm';
  readonly handles = ['s12_entry', 's12_exit', 'bag_update'] as const;

  private _lootMs: number = DEFAULT_LOOT_COLLECTION_MS;
  private _ctx: EngineContext | null = null;

  setLootDurationMs(ms: number): void {
    this._lootMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
  }

  onStart(ctx: EngineContext): void { this._ctx = ctx; }
  onStop(): void { this._ctx = null; }

  /** Test affordance — delegates to the registry. */
  isLootCollecting(): boolean {
    return this._ctx?.registry.seasonal('overrealm')?.isLootCollecting() ?? false;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Fully paused-guarded: every event here is crediting or loot-timer
    // management (start, arm/refresh). Teardown is not structural to THIS
    // handler — town entry finishes overrealm via ZoneHandler.finishAll, which
    // runs while paused. Loot timers deliberately keep running through a pause.
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 's12_entry': {
        // Same-map re-entry while previous loot timer is still ticking — player
        // took another portal. Cancel the timer; existing tracker continues.
        ctx.registry.seasonal('overrealm')?.cancelLootTimer();
        ctx.registry.startSeasonal({type: 'overrealm', lootDurationMs: this._lootMs}, emit);
        break;
      }
      case 's12_exit':
        ctx.registry.seasonal('overrealm')?.armLootTimer();
        break;
      case 'bag_update':
        ctx.registry.seasonal('overrealm')?.refreshLootTimer();
        break;
    }
  }
}
