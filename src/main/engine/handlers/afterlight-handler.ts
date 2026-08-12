import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * AfterlightHandler — Afterlight (S15 "ShouYe") translator.
 *
 * A bounded in-map encounter: activating the hearse cart spawns a warden boss
 * plus scripted mob waves, and the boss dying (or killing you) ends it.
 *   afterlight_start   : start the tracker (or fold into the running one)
 *   afterlight_special : a Special/Bride/Goblin variant is running — re-arm
 *   afterlight_wave    : keep the run alive — resume if dormant, else reset
 *   afterlight_end     : make the window terminal, then arm it
 *
 * The window is a WAVE window until the boss resolves, so expiry parks the
 * tracker dormant (pauseOnLootExpiry) rather than ending the run: real
 * encounters contain spawn lulls of 12-99s, and destroying the tracker there
 * would split one fight into several. A later wave resumes the same run.
 * _Win/_Lose flips expiry to finish so the post-kill window closes it for good.
 *
 * Only waves move the window — pickups never do, so `bag_update` is absent from
 * `handles` (same rule as the Sandlord tile). Special usually logs no boss death
 * at all, so its BGM Stop is the end marker the processor maps to afterlight_end.
 *
 * In-map mechanic: the map keeps running and drops fall through.
 */
export class AfterlightHandler implements EventHandler {
  readonly name    = 'afterlight';
  readonly handles = ['afterlight_start', 'afterlight_special', 'afterlight_wave', 'afterlight_end'] as const;

  private _lootMs: number = DEFAULT_LOOT_COLLECTION_MS;
  /** True once the boss has resolved, so a repeated end marker can't re-arm. */
  private _terminal: boolean = false;

  onStart(): void {
    this._terminal = false;
  }

  setLootDurationMs(ms: number): void {
    this._lootMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Fully paused-guarded: there is no structural latch to consume here (the
    // encounter's start and end are both logged), so every event is crediting.
    // Teardown is via ZoneHandler.finishAll on town entry (runs while paused) —
    // that is what closes the rare encounter abandoned by leaving the map.
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 'afterlight_special': {
        // The BGM bracket only identifies the variant — its Stop is the end
        // marker for a Special, which usually logs no boss death at all.
        const t = ctx.registry.seasonal('afterlight');
        if (t) t.resetLootTimer();
        break;
      }

      case 'afterlight_start': {
        if (!ctx.inMap || ctx.registry.hasBubble()) return;
        // activateSeasonal is start-if-absent — a second encounter in the same
        // map folds into the running tracker, so the terminal flag MUST be
        // cleared here: otherwise the folded encounter inherits finish-on-expiry
        // and its first spawn lull destroys the run.
        const t = ctx.registry.activateSeasonal({
          type:              'afterlight',
          lootDurationMs:    this._lootMs,
          pauseOnLootExpiry: true,
        }, emit);
        this._terminal = false;
        t?.setPauseOnLootExpiry(true);
        t?.resetLootTimer();
        break;
      }

      case 'afterlight_wave': {
        const t = ctx.registry.seasonal('afterlight');
        if (!t) return; // never start from a wave — a missed _App ends at town entry
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

      case 'afterlight_end': {
        // De-dupe on _terminal, not isLootCollecting(): a wave window is live
        // for the whole fight now, so "already collecting" no longer
        // distinguishes a repeated _Win from the first one.
        const t = ctx.registry.seasonal('afterlight');
        if (t && !this._terminal) {
          this._terminal = true;
          t.setPauseOnLootExpiry(false);
          t.armLootTimer();
        }
        break;
      }
    }
  }
}
