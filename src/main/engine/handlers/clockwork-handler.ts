import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;
/** Abandonment timeout for a cogwheel fight — how long the row stays lit with no
 *  further pulse. Not the loot window: nothing drops until the turn-in. */
const COGWHEEL_IDLE_MS = 10_000;

/**
 * ClockworkHandler — Clockwork Ballet (S7) translator.
 *
 * The mechanic spans a whole map:
 *   s7_podium       : create the tracker, dormant and TIMING-ONLY (greyed out)
 *   s7_cogwheel     : a cogwheel is spinning — light the row, re-arm the timeout
 *   s7_cogwheel_end : that cogwheel finished — grey the row out again
 *   s7_turnin       : claim drops, arm the terminal loot window
 *   s7_fail         : outcome annotation only
 *   bag_update      : decaying refresh, but only once terminal
 *
 * Cogwheel fights drop no loot of their own — their kills belong to the map — so
 * the tracker runs `claimsDrops: false` until the turn-in. Being active is what
 * normally makes a seasonal the drop writer, so parking it between fights is not
 * enough on its own: it is awake for the seconds each fight lasts.
 *
 * Concurrent cogwheels are NOT counted, because the log cannot express them:
 * `Gear_Idle` is an ambient loop that re-fires every ~2.8s while the player
 * stands near a spinning cogwheel, with no id to tell a second one apart from
 * the first still turning. Engagement is therefore a boolean. If two overlap and
 * one finishes, the row greys out early — and the survivor's next pulse (~2.8s)
 * lights it straight back up, so the error is small and self-correcting. A
 * drifting +1/-1 counter would instead pin the row on for the whole map:
 * measured 14 spin-up markers against 6 completions per encounter.
 *
 * The cogwheel timeout is an abandonment guard, re-armed by each pulse, and its
 * expiry only parks the tracker (`pauseOnLootExpiry`) so a later cogwheel
 * resumes the same run. Only the turn-in window is terminal. Pickups move the
 * TERMINAL window only (decaying refresh, as for Carjack) — mid-fight a pickup
 * is not evidence the cogwheel is still turning, and the tracker owns nothing
 * then anyway.
 *
 * Once `_terminal` is set every fight-phase event is ignored. A bonus cogwheel
 * really can pay out during the reward sequence — 14 of 16 measured turn-ins had
 * one land 1-2ms later — and parking there would cancel the loot window and
 * strand the entire reward burst.
 *
 * In-map mechanic: the map keeps running and drops fall through.
 */
export class ClockworkHandler implements EventHandler {
  readonly name    = 'clockwork';
  readonly handles = ['s7_podium', 's7_cogwheel', 's7_cogwheel_end', 's7_turnin', 's7_fail', 'bag_update'] as const;

  private _lootMs: number = DEFAULT_LOOT_COLLECTION_MS;
  /** True once the vouchers are turned in, so a repeat can't re-arm. */
  private _terminal: boolean = false;

  onStart(): void {
    this._terminal = false;
  }

  setLootDurationMs(ms: number): void {
    this._lootMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Fully paused-guarded: every event either credits or moves a window. This
    // handler's OWN self-pause (a greyed-out row between cogwheels) must survive
    // a session resume — the engine only resumes seasonals IT paused. Teardown
    // is via ZoneHandler.finishAll on town entry (runs while paused).
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 's7_podium': {
        // A second podium in the same map folds into the tracker startSeasonal
        // returns, so reopen the fight phase explicitly either way.
        this._terminal = false;
        const t = ctx.registry.startSeasonal({
          type:              'clockwork',
          lootDurationMs:    COGWHEEL_IDLE_MS,
          pauseOnLootExpiry: true,
          claimsDrops:       false,
        }, emit);
        // startSeasonal returns an EXISTING tracker untouched, so a folded
        // second podium needs the fight-phase state restored explicitly.
        if (t) {
          ctx.registry.setSeasonalClaimsDrops(t, false, emit);
          t.setLootDurationMs(COGWHEEL_IDLE_MS);
          t.setPauseOnLootExpiry(true);
          t.pauseTracker();
        }
        break;
      }

      case 's7_cogwheel': {
        // Podium-only creation: a cogwheel with no tracker is ignored, so a
        // missed podium falls through to town-entry teardown rather than
        // leaving a phantom tracker mid-map.
        const t = ctx.registry.seasonal('clockwork');
        if (!t || this._terminal) break;
        if (!t.active) t.resumeTracker();
        // Every pulse re-arms: the loop repeats every ~2.8s, so a fight that
        // outlives the timeout keeps the row lit. Unthrottled and unconditional
        // — a throttled call on a tracker whose window just expired would leave
        // it active with no timer at all.
        t.armLootTimer();
        break;
      }

      case 's7_cogwheel_end': {
        // Definitive: Gear_Exp fires once per completed cogwheel. Grey out at
        // once rather than waiting out the timeout.
        const t = ctx.registry.seasonal('clockwork');
        if (t?.active && !this._terminal) {
          t.cancelLootTimer();
          t.pauseTracker();
        }
        break;
      }

      case 's7_turnin': {
        // Fires for wins and losses alike, and both drop loot. Claiming drops
        // and flipping expiry must both happen BEFORE arming: the tracker owns
        // nothing during the fight phase, and a park-on-expiry window would
        // never end the run.
        const t = ctx.registry.seasonal('clockwork');
        if (t && !this._terminal) {
          this._terminal = true;
          t.resumeTracker();
          ctx.registry.setSeasonalClaimsDrops(t, true, emit);
          t.setLootDurationMs(this._lootMs);
          t.setPauseOnLootExpiry(false);
          t.armLootTimer();
        }
        break;
      }

      case 's7_fail':
        // Outcome only — the turn-in already armed the loot window.
        break;

      case 'bag_update':
        // Only after the turn-in: during the fight phase the pickup is the map's
        // (claimsDrops: false) and must not extend the abandonment timeout.
        if (this._terminal) ctx.registry.seasonal('clockwork')?.refreshLootTimer();
        break;
    }
  }
}
