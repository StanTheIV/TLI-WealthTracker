/**
 * Shared helpers for seasonal mechanic handlers.
 *
 * Seasonals run concurrently (Lunaria-during-Overrealm in Netherrealm), so
 * `ctx.seasonals` is a `Map<SeasonalType, Tracker>` and every helper here
 * takes a `seasonalType` parameter to address the right slot. These helpers
 * also handle the bubble-exclusivity rule (Sandlord), the writer-cache
 * invalidation that powers the source-breakdown pie, and the post-combat
 * loot-window timers.
 */
import {Tracker} from '@/main/engine/tracker';
import type {SeasonalType} from '@/main/engine/tracker';
import type {EngineContext} from '@/main/engine/context';
import type {EmitFn} from '@/main/engine/types';
import {LootCollectionTimer} from '@/main/engine/loot-collection-timer';
import {log} from '@/main/logger';

const TOWN_MARKER = 'YuJinZhiXiBiNanSuo';

/**
 * Start a seasonal tracker. Idempotent for the same type. Bubble-exclusivity
 * rule applies in both directions:
 *   - Starting a bubble seasonal (Sandlord, ownsBubble=true) finishes every
 *     active non-bubble seasonal first via finishSeasonal.
 *   - Starting a non-bubble seasonal while a bubble is already active is a
 *     silent no-op + debug log.
 */
export function startSeasonal(
  type: SeasonalType,
  ctx:  EngineContext,
  emit: EmitFn,
  opts: {ownsBubble?: boolean} = {},
): void {
  // Idempotent re-entry of the same type.
  if (ctx.seasonals.has(type)) return;

  const ownsBubble = opts.ownsBubble ?? false;

  if (ownsBubble) {
    // Bubble starting — evict everything else first so SessionPersistence
    // captures their drops as overlap rows under the current map.
    for (const otherType of [...ctx.seasonalsStartOrder]) {
      finishSeasonal(otherType, ctx, emit);
    }
  } else if (ctx.hasSeasonalThatOwnsBubble()) {
    // Non-bubble trying to start while a bubble is up — refuse silently.
    log.debug('engine', `${type} start ignored: bubble seasonal active`);
    return;
  }

  const tracker = new Tracker('seasonal', type, ownsBubble);
  ctx.seasonals.set(type, tracker);
  ctx.seasonalsStartOrder.push(type);
  ctx.invalidateWriter();
  emit({type: 'tracker_started', tracker: tracker.snapshot(), timestamp: Date.now()});
}

/** Finish a specific seasonal. Idempotent if the type isn't active. */
export function finishSeasonal(type: SeasonalType, ctx: EngineContext, emit: EmitFn): void {
  const tracker = ctx.seasonals.get(type);
  if (!tracker) return;
  const snap = tracker.snapshot();
  ctx.seasonals.delete(type);
  const idx = ctx.seasonalsStartOrder.indexOf(type);
  if (idx >= 0) ctx.seasonalsStartOrder.splice(idx, 1);
  ctx.invalidateWriter();
  emit({type: 'tracker_finished', tracker: snap, timestamp: Date.now()});
}

/**
 * Pause a seasonal tracker (Lunaria between strum episodes, Vorex on window
 * close). Wraps Tracker.pause() with writer-cache invalidation and a
 * tracker_update emit so the renderer picks up the dimmed state.
 */
export function pauseSeasonal(type: SeasonalType, ctx: EngineContext, emit: EmitFn): void {
  const tracker = ctx.seasonals.get(type);
  if (!tracker || !tracker.active) return;
  tracker.pause();
  ctx.invalidateWriter();
  emit({type: 'tracker_update', tracker: tracker.snapshot(), timestamp: Date.now()});
}

/** Resume a paused seasonal tracker. Does NOT reorder seasonalsStartOrder
 *  (start-time order is permanent — see writer rule). */
export function resumeSeasonal(type: SeasonalType, ctx: EngineContext, emit: EmitFn): void {
  const tracker = ctx.seasonals.get(type);
  if (!tracker || tracker.active) return;
  tracker.resume();
  ctx.invalidateWriter();
  emit({type: 'tracker_update', tracker: tracker.snapshot(), timestamp: Date.now()});
}

/**
 * Town-entry shortcut for seasonals that use a post-combat loot collection
 * timer (Carjack, Clockwork, Overrealm). When the player enters town while
 * the timer is still running, cancel the timer and finish the seasonal
 * immediately.
 *
 * @returns true if the timer was cancelled and the seasonal finished;
 *          false if no town entry / no active timer (caller is a no-op).
 */
export function finishOnTownEntry(
  toScene:      string,
  lootTimer:    LootCollectionTimer | null,
  ctx:          EngineContext,
  emit:         EmitFn,
  seasonalType: SeasonalType,
): boolean {
  if (!toScene.includes(TOWN_MARKER) || !lootTimer?.active) return false;
  lootTimer.cancel();
  emit({type: 'loot_window_ended', seasonalType, timestamp: Date.now()});
  finishSeasonal(seasonalType, ctx, emit);
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
  return new LootCollectionTimer(durationMs, () => {
    emit({type: 'loot_window_ended', seasonalType, timestamp: Date.now()});
    onExpire?.();
    finishSeasonal(seasonalType, ctx, emit);
  });
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
 * Pickup-driven refresh of the timer. Shrinks the next window to 80% of the
 * current one when remaining time has fallen below that threshold; otherwise
 * a no-op. When it does re-arm, emit a fresh `loot_window_started` event
 * with the new (shorter) deadline so the renderer's countdown stays in sync.
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
 * Strum-driven reset of the timer. Unconditionally re-arms to the full
 * configured window, undoing any decay from prior pickup-refreshes. Used by
 * Lunaria when a fresh strum lands while a tracker is already active —
 * pickup decay shouldn't punish the player for re-engaging.
 */
export function resetLootTimer(
  timer:        LootCollectionTimer,
  seasonalType: SeasonalType,
  emit:         EmitFn,
): void {
  timer.reset();
  const deadline = timer.deadline ?? Date.now() + timer.durationMs;
  emit({type: 'loot_window_started', seasonalType, deadline, timestamp: Date.now()});
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

/**
 * Pausing variant of createLootTimer for seasonals like Lunaria where the
 * encounter can re-trigger inside the same map. On expiry, the seasonal
 * tracker is *paused* (kept in ctx.seasonals so accumulated drops persist)
 * instead of finished, so a subsequent strum can resume it. The tracker
 * is finished by ZoneHandler on town entry like every other seasonal.
 *
 * The post-expiry tracker_update lets the renderer pick up the new `active`
 * flag and dim the row visually. Writer-cache invalidation is handled by
 * pauseSeasonal so the next drop attributes to the next-newest active source.
 */
export function createPausingLootTimer(
  durationMs:    number,
  seasonalType:  SeasonalType,
  ctx:           EngineContext,
  emit:          EmitFn,
  onExpire?:     () => void,
): LootCollectionTimer {
  return new LootCollectionTimer(durationMs, () => {
    emit({type: 'loot_window_ended', seasonalType, timestamp: Date.now()});
    onExpire?.();
    pauseSeasonal(seasonalType, ctx, emit);
  });
}
