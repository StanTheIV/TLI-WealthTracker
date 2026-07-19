import type {EngineContext} from './context';
import type {EmitFn} from './types';

/**
 * Shared map-pause for seasonal interludes — panel minigames (Arcana tarot,
 * Vorex window) and their fight scenes. While an interlude is up the player
 * isn't farming, so the map tracker freezes and its elapsed (the authority
 * for map time) excludes the whole interlude. In-map combat mechanics
 * (Lunaria, Carjack, …) deliberately do NOT pause the map.
 * `ctx.mapPausedForInterludeAt` is safely shared: one interlude at a time.
 */

/** Interlude opened (panel or fight scene): freeze an actively-running map.
 *  No-op from town (no map) or when the map is already paused — the marker
 *  then persists from the first pause. */
export function pauseMapForInterlude(ctx: EngineContext, emit: EmitFn): void {
  if (ctx.registry.map?.active) {
    ctx.registry.pauseMap(emit);
    ctx.mapPausedForInterludeAt = Date.now();
  }
}

/** Interlude over (panel closed / fight left): resume the map if it's still
 *  there — unless the session is paused (then Engine.resume() owns it) or the
 *  exit went to town (ZoneHandler already finished the map off its frozen
 *  elapsed). Always clears the marker. */
export function resolveMapInterlude(ctx: EngineContext, emit: EmitFn): void {
  if (ctx.mapPausedForInterludeAt !== null
      && ctx.registry.map && !ctx.registry.map.active && !ctx.paused) {
    ctx.registry.resumeMap(emit);
  }
  ctx.mapPausedForInterludeAt = null;
}
