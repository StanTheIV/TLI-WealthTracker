/**
 * Shared helpers for seasonal mechanic handlers.
 *
 * All seasonal handlers (Dream, Vorex, Overrealm, Carjack, Clockwork,
 * Sandlord) write to the same ctx.seasonal slot. These helpers centralise
 * start/finish + the post-combat-loot-timer "town entry cuts the window
 * short" pattern so each handler doesn't duplicate that logic.
 */
import {Tracker} from '@/main/engine/tracker';
import type {SeasonalType} from '@/main/engine/tracker';
import type {EngineContext} from '@/main/engine/context';
import type {EmitFn} from '@/main/engine/types';
import {LootCollectionTimer} from '@/main/engine/loot-collection-timer';

const TOWN_MARKER = 'YuJinZhiXiBiNanSuo';

export function startSeasonal(
  type: SeasonalType,
  ctx:  EngineContext,
  emit: EmitFn,
  opts: {ownsBubble?: boolean} = {},
): void {
  // If a different seasonal type is already running, finish it first.
  if (ctx.seasonal && ctx.seasonal.seasonalType !== type) {
    finishSeasonal(ctx, emit);
  }
  if (!ctx.seasonal) {
    ctx.seasonal = new Tracker('seasonal', type, opts.ownsBubble ?? false);
    emit({type: 'tracker_started', tracker: ctx.seasonal.snapshot(), timestamp: Date.now()});
  }
}

export function finishSeasonal(ctx: EngineContext, emit: EmitFn): void {
  if (!ctx.seasonal) return;
  const snap   = ctx.seasonal.snapshot();
  ctx.seasonal = null;
  emit({type: 'tracker_finished', tracker: snap, timestamp: Date.now()});
}

/**
 * Town-entry shortcut for seasonals that use a post-combat loot collection
 * timer (Carjack, Clockwork, Overrealm). When the player enters town while
 * the timer is still running, cancel the timer and finish the seasonal
 * immediately. Returns the (now null) loot timer so the caller can `=` it
 * back to its handler-local field in one expression.
 *
 * @returns true if the timer was cancelled and the seasonal finished;
 *          false if no town entry / no active timer (caller is a no-op).
 */
export function finishOnTownEntry(
  toScene: string,
  lootTimer: LootCollectionTimer | null,
  ctx: EngineContext,
  emit: EmitFn,
): boolean {
  if (!toScene.includes(TOWN_MARKER) || !lootTimer?.active) return false;
  const seasonalType = ctx.seasonal?.seasonalType;
  lootTimer.cancel();
  emit({type: 'loot_window_ended', seasonalType, timestamp: Date.now()});
  finishSeasonal(ctx, emit);
  return true;
}

/**
 * Construct a loot timer that wires up the standard renderer-facing events:
 *   - emits `loot_window_started` on start (with computed deadline)
 *   - emits `loot_window_ended` when the timer expires (via this helper) AND
 *     when the caller cancels via `cancelLootTimer()` below
 * The handler passes an `onExpire` callback that runs after the
 * `loot_window_ended` event is emitted but before `finishSeasonal` — typical
 * use is to null out the handler's local timer reference.
 */
export function createLootTimer(
  durationMs:    number,
  seasonalType:  SeasonalType,
  ctx:           EngineContext,
  emit:          EmitFn,
  onExpire?:     () => void,
): LootCollectionTimer {
  const timer = new LootCollectionTimer(durationMs, () => {
    emit({type: 'loot_window_ended', seasonalType, timestamp: Date.now()});
    onExpire?.();
    finishSeasonal(ctx, emit);
  });
  return timer;
}

/**
 * Start the timer and emit the corresponding `loot_window_started` event
 * with the timer's deadline. Mirror this from any place a fresh timer is
 * armed so the renderer always has the latest deadline.
 */
export function startLootTimer(
  timer:        LootCollectionTimer,
  seasonalType: SeasonalType,
  emit:         EmitFn,
): void {
  timer.start();
  const deadline = timer.deadline ?? Date.now() + timer.durationMs;
  emit({type: 'loot_window_started', seasonalType, deadline, timestamp: Date.now()});
}

/**
 * Refresh the timer (called on bag pickups). When the refresh actually
 * re-armed the underlying setTimeout (i.e. remaining time was below 80% of
 * the configured window), emit a fresh `loot_window_started` event with the
 * new deadline so the renderer's countdown stays in sync.
 */
export function refreshLootTimer(
  timer:        LootCollectionTimer,
  seasonalType: SeasonalType,
  emit:         EmitFn,
): void {
  if (timer.refresh()) {
    const deadline = timer.deadline ?? Date.now();
    emit({type: 'loot_window_started', seasonalType, deadline, timestamp: Date.now()});
  }
}

/**
 * Cancel a still-active loot timer (e.g. on re-entry) and emit
 * `loot_window_ended`. No-op if the timer wasn't active.
 */
export function cancelLootTimer(
  timer:        LootCollectionTimer,
  seasonalType: SeasonalType,
  emit:         EmitFn,
): void {
  if (!timer.active) return;
  timer.cancel();
  emit({type: 'loot_window_ended', seasonalType, timestamp: Date.now()});
}
