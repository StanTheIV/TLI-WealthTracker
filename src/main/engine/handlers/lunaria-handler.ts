import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import type {LootCollectionTimer} from '@/main/engine/loot-collection-timer';
import {
  startSeasonal,
  createPausingLootTimer,
  startLootTimer,
  refreshLootTimer,
  resumeSeasonal,
} from './seasonal-helpers';

const DEFAULT_LOOT_COLLECTION_MS = 5_000;

/**
 * LunariaHandler — manages the Lunaria (S14 "MingYue") seasonal tracker
 * lifecycle inside Netherrealm maps.
 *
 * Lunaria is unique among seasonals in that it can re-trigger several times
 * within a single regular map: each cluster of petrified statues is its own
 * encounter. Drops from all episodes in the same map should accumulate into
 * ONE seasonal tracker that ZoneHandler finishes on town entry.
 *
 * Lifecycle:
 *   s14_strum (UECtrlComponent@ DoAction S14GameplayStart):
 *     - First ever              → startSeasonal('lunaria') + arm pausing timer.
 *     - Tracker exists, paused  → resume() + arm a fresh pausing timer.
 *     - Tracker exists, active  → refresh the existing timer (only re-arms
 *                                 if remaining time dropped below 80% of the
 *                                 configured window — same rule as Overrealm).
 *   bag_update (during the loot window):
 *     - Refreshes the existing timer (same 80% rule).
 *
 *   When the pausing loot timer expires, the tracker pauses in place. The
 *   next strum resumes it. ZoneHandler finishes on town entry.
 *
 * No `s14_end` / encounter-end signal: the loot timer is the sole "end of
 * episode" mechanism, driven by the absence of further strums or pickups.
 *
 * Must be registered AFTER ZoneHandler and BEFORE ItemHandler.
 */
export class LunariaHandler implements EventHandler {
  readonly name    = 'lunaria';
  readonly handles = ['s14_strum', 'bag_update'] as const;

  private _lootTimer:      LootCollectionTimer | null = null;
  private _lootDurationMs: number                     = DEFAULT_LOOT_COLLECTION_MS;

  /** Update the post-strum loot window in milliseconds. Takes effect on the
   *  next strum (the in-flight timer, if any, keeps its original duration). */
  setLootDurationMs(ms: number): void {
    const next = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_LOOT_COLLECTION_MS;
    this._lootDurationMs = next;
  }

  onStop(_ctx: EngineContext): void {
    this._lootTimer?.cancel();
    this._lootTimer = null;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;

    if (event.type === 's14_strum') {
      this._handleStrum(ctx, emit);
    } else if (event.type === 'bag_update' && this._lootTimer) {
      // Pickup during the loot window — same 80%-threshold refresh rule as
      // Overrealm/Carjack/Clockwork. Lunaria is an in-Netherrealm mechanic
      // so pickups elsewhere can't reach this branch (timer is null).
      refreshLootTimer(this._lootTimer, 'lunaria', emit);
    }
  }

  private _handleStrum(ctx: EngineContext, emit: EmitFn): void {
    const existing = ctx.seasonals.get('lunaria');

    if (!existing) {
      // First strum of the map. startSeasonal silently no-ops if a bubble
      // seasonal is active (defensive — shouldn't happen for Lunaria since
      // Sandlord runs in its own hub).
      startSeasonal('lunaria', ctx, emit);
      if (!ctx.seasonals.has('lunaria')) return; // bubble blocked us
      this._armLootTimer(ctx, emit);
      return;
    }

    if (!existing.active) {
      // Paused between episodes — resume and arm a fresh full-window timer.
      resumeSeasonal('lunaria', ctx, emit);
      this._armLootTimer(ctx, emit);
      return;
    }

    // Active tracker, in-flight timer — refresh under the 80% rule. A strum
    // is treated as engagement just like a pickup; both share the same
    // refresh semantics so the timer never re-arms on every event.
    if (this._lootTimer) {
      refreshLootTimer(this._lootTimer, 'lunaria', emit);
    } else {
      // Defensive: tracker active but no timer (shouldn't happen — _arm runs
      // on tracker creation/resume). Arm a fresh one.
      this._armLootTimer(ctx, emit);
    }
  }

  private _armLootTimer(ctx: EngineContext, emit: EmitFn): void {
    this._lootTimer?.cancel();
    this._lootTimer = createPausingLootTimer(this._lootDurationMs, 'lunaria', ctx, emit, () => {
      this._lootTimer = null;
    });
    startLootTimer(this._lootTimer, 'lunaria', emit);
  }
}
