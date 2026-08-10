import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const DEFAULT_WAVE_MS = 10_000;
// Mob-landing markers arrive 30+/sec during a spawn burst; resets are
// rate-limited so the overlay isn't flooded with loot_window_started events.
const WAVE_RESET_INTERVAL_MS = 1_000;

/**
 * SandlordMapHandler — Sandlord (S10) IN-MAP coin-tile translator.
 *
 * Shares the 'sandlord' seasonal type with the hub bubble but runs as phase
 * 'map': an in-map mechanic, so the map keeps running and drops fall through.
 * Multiple tiles in one map fold into the same tracker, dormant between them.
 *   s10_tile / s10_wave (first)  : start tracker + arm the wave window
 *   s10_tile / s10_wave (dormant): resume + arm a fresh window
 *   s10_tile / s10_wave (active) : reset the window (full re-arm, rate-limited)
 *   s10_quench                   : cancel the window + go dormant
 *
 * s10_wave covers both a machine engaging AND every mob landing — a machine
 * fires its Active marker only once but spawns several rounds, so the landing
 * markers are what attest a round is still coming. A quench can fire per
 * machine while another is still spawning; the next landing simply resumes
 * the tracker, so an early quench self-heals.
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
  readonly handles = ['s10_tile', 's10_wave', 's10_quench'] as const;

  private _waveMs:      number = DEFAULT_WAVE_MS;
  private _lastResetAt: number = 0;

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
      const t = ctx.registry.seasonal('sandlord');
      if (t) {
        t.cancelLootTimer();
        t.pauseTracker();
      }
      return;
    }

    if (event.type !== 's10_tile' && event.type !== 's10_wave') return;

    // Tile and wave share one activation path. A wave with no tracker starts one
    // defensively — the tile line is missed whenever the watcher attaches after
    // the tile was already activated mid-map.
    const existing = ctx.registry.seasonal('sandlord');
    if (!existing) {
      const t = ctx.registry.startSeasonal({
        type:              'sandlord',
        phase:             'map',
        lootDurationMs:    this._waveMs,
        pauseOnLootExpiry: true,
      }, emit);
      t?.armLootTimer();
      this._lastResetAt = Date.now();
      return;
    }

    if (!existing.active) {
      existing.resumeTracker();
      existing.armLootTimer();
      this._lastResetAt = Date.now();
      return;
    }

    // Active tracker, window in flight — wave activity refreshes it in full,
    // at most once per WAVE_RESET_INTERVAL_MS.
    const now = Date.now();
    if (now - this._lastResetAt >= WAVE_RESET_INTERVAL_MS) {
      existing.resetLootTimer();
      this._lastResetAt = now;
    }
  }
}
