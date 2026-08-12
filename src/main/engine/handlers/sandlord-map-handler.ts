import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_WAVE_MS = 10_000;

/**
 * SandlordMapHandler — Sandlord (S10) IN-MAP coin-tile translator.
 *
 * Shares the 'sandlord' seasonal type with the hub bubble but runs as phase
 * 'map': an in-map mechanic, so the map keeps running and drops fall through.
 * Multiple tiles in one map fold into the same tracker, dormant between them.
 *   s10_wave (first)  : start tracker + arm the wave window
 *   s10_wave (dormant): resume + arm a fresh window
 *   s10_wave (active) : reset the window (full re-arm, rate-limited)
 *   s10_quench        : re-arm the window so the last wave's loot still credits
 *
 * s10_wave covers both a machine engaging AND every mob landing — a machine
 * fires its Active marker only once but spawns several rounds, so the landing
 * markers are what attest a round is still coming.
 *
 * A quench alone is not the end: it fires per MACHINE, and a tile runs several.
 * Measured across 41 quenches, the next Active_Lp followed within 5s in 37 cases
 * (median 1.1s, min 68ms), and one 14s encounter contained 8 quenches. So quench
 * re-arms the window rather than ending anything — the last machine's drops keep
 * crediting. But a quench with NO follow-up wave is the real end of the tile, so
 * that window finishes the run outright instead of parking it dormant.
 *
 * Before the first quench the window is pure wave activity, so expiry only parks
 * the tracker: the player may have walked away mid-tile and a later wave must
 * resume the same run. Town entry remains the backstop for both.
 *
 * The timer is a WAVE-ACTIVITY window, not a loot window — it repurposes the
 * loot-timer machinery so expiry pauses the tracker (`pauseOnLootExpiry`). Hence
 * 'bag_update' is deliberately absent from `handles`: unlike Lunaria, pickups
 * must NOT refresh it — only waves attest the tile is still running, otherwise
 * a tile that quietly died would keep owning drops for the rest of the map.
 *
 * The same audio markers fire densely inside the hub's Pillage minigame, so
 * every event is gated on "in a regular map, no bubble".
 */
export class SandlordMapHandler implements EventHandler {
  readonly name    = 'sandlord-map';
  readonly handles = ['s10_wave', 's10_quench'] as const;

  private _waveMs: number = DEFAULT_WAVE_MS;
  setWaveDurationMs(ms: number): void {
    this._waveMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_WAVE_MS;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    // Fully paused-guarded: tile/wave starts and quench are all crediting. This
    // handler's OWN self-pause (wave expiry between tiles) must survive a
    // session resume — the engine only resumes seasonals IT paused. Teardown is
    // via ZoneHandler.finishAll on town entry (runs while paused).
    if (ctx.phase !== 'tracking' || ctx.paused) return;
    // The hub's Pillage minigame replays these markers; only a regular map counts.
    if (!ctx.inMap || ctx.registry.hasBubble()) return;

    if (event.type === 's10_quench') {
      // Re-arm rather than cancel: the machine's last wave is still dropping,
      // and cancelling stripped that loot from the tracker. If another machine
      // follows, the next wave clears the flag; if none does, this window is
      // the tile's real end and expiry finishes the run.
      const t = ctx.registry.seasonal('sandlord');
      if (t) {
        t.setPauseOnLootExpiry(false);
        t.resetLootTimer();
      }
      return;
    }

    if (event.type !== 's10_wave') return;

    const existing = ctx.registry.seasonal('sandlord');
    if (!existing) {
      const t = ctx.registry.startSeasonal({
        type:              'sandlord',
        phase:             'map',
        lootDurationMs:    this._waveMs,
        pauseOnLootExpiry: true,
      }, emit);
      t?.armLootTimer();
      return;
    }

    if (!existing.active) {
      existing.setPauseOnLootExpiry(true);
      existing.resumeTracker();
      existing.armLootTimer();
      return;
    }

    // A wave means the tile is still running, so expiry goes back to parking the
    // tracker. The window in flight may be the terminal one a quench armed —
    // that must be replaced outright, never merely throttled, or it expires
    // under the new park-flag and leaves a dormant tracker with no timer.
    existing.setPauseOnLootExpiry(true);
    existing.resetLootTimerThrottled();
  }
}
