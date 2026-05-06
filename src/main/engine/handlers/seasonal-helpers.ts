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
import type {LootCollectionTimer} from '@/main/engine/loot-collection-timer';

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
  lootTimer.cancel();
  finishSeasonal(ctx, emit);
  return true;
}
