import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * CarjackHandler — Carjack (S11) translator.
 *
 *   s11_start  : start tracker (idempotent), arm the activity window
 *   s11_wave   : keep the run alive — resume if dormant, else reset
 *   s11_end    : make the window terminal, then arm it
 *   bag_update : decaying refresh, but only once terminal
 *   zone_transition (town): handled centrally by ZoneHandler.finishAll.
 *
 * The game's Stop marker is a fixed post-encounter sequence, not an activity
 * signal — one measured encounter ran 24s past its last mob marker. So the
 * window tracks combat instead: expiry parks the tracker dormant (a real fight
 * contained a 7.89s lull, so ending there would drop the last kill's loot) and
 * a later mob marker resumes the same run. Stop flips expiry to finish.
 */
export class CarjackHandler implements EventHandler {
  readonly name    = 'carjack';
  readonly handles = ['s11_start', 's11_wave', 's11_end', 'bag_update'] as const;

  private _lootMs: number = DEFAULT_LOOT_COLLECTION_MS;
  /** True once the encounter has resolved: only then may pickups refresh. */
  private _terminal: boolean = false;

  onStart(): void {
    this._terminal = false;
  }

  setLootDurationMs(ms: number): void {
    this._lootMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Fully paused-guarded: all crediting / loot-timer events. Teardown is via
    // ZoneHandler.finishAll on town entry (runs while paused).
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 's11_start': {
        // startSeasonal returns a lingering tracker WITHOUT resuming it, so a
        // fresh Play line landing on a dormant one has to wake it explicitly.
        const t = ctx.registry.startSeasonal({
          type:              'carjack',
          lootDurationMs:    this._lootMs,
          pauseOnLootExpiry: true,
        }, emit);
        this._terminal = false;
        if (t && !t.active) t.resumeTracker();
        t?.setPauseOnLootExpiry(true);
        t?.resetLootTimer();
        break;
      }

      case 's11_wave': {
        const t = ctx.registry.seasonal('carjack');
        if (!t) return;
        // Waking a dormant tracker must arm unthrottled: expiry already nulled
        // the timer, so a throttled call would leave it active with no window.
        if (!t.active) {
          t.resumeTracker();
          t.armLootTimer();
        } else {
          t.resetLootTimerThrottled();
        }
        break;
      }

      case 's11_end': {
        // De-dupe on _terminal: Stop fires twice per encounter (6-34s apart) and
        // an activity window is live throughout, so isLootCollecting() can no
        // longer tell a repeat from the first. A Stop arriving after the run
        // already closed finds no tracker and is a no-op.
        const t = ctx.registry.seasonal('carjack');
        if (t && !this._terminal) {
          this._terminal = true;
          t.setPauseOnLootExpiry(false);
          t.armLootTimer();
        }
        break;
      }

      case 'bag_update':
        // Only after the encounter resolves — mid-fight, a pickup is not
        // evidence that combat is still going.
        if (this._terminal) ctx.registry.seasonal('carjack')?.refreshLootTimer();
        break;
    }
  }
}
