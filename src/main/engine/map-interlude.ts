import type {EngineContext} from './context';
import type {EmitFn} from './types';

/**
 * Shared map-pause for seasonal interludes — panel minigames (Arcana tarot,
 * Vorex window, Tartarus board), their fight scenes, and a map → Sandlord hub
 * run. While an interlude is up the player isn't farming, so the map tracker
 * freezes and its elapsed (the authority for map time) excludes the whole
 * interlude. In-map combat mechanics (Lunaria, Carjack, …) deliberately do
 * NOT pause the map. The claim (`registry.mapInterludeAt`) is safely shared —
 * one interlude at a time — and is state of the map it froze: the registry
 * drops it with that map, so an interlude whose end is never seen (a panel
 * left open into town) can't outlive it.
 */

/** Interlude opened (panel or fight scene): freeze an actively-running map.
 *  No-op from town (no map) or when an interlude already froze the map — the
 *  claim then stands from the first pause. A map the SESSION pause froze is
 *  claimed as-is (nothing to pause), so the session resume leaves it frozen
 *  while the interlude is still up. */
export function pauseMapForInterlude(ctx: EngineContext, emit: EmitFn): void {
  const map = ctx.registry.map;
  if (map?.active || (map && ctx.paused)) {
    ctx.registry.freezeMapForInterlude(emit, Date.now());
  }
}

/** Interlude over (panel closed / fight left): resume the map it froze —
 *  unless the session is paused (then Engine.resume() owns it). An exit to
 *  town finds no claim: ZoneHandler already finished the map off its frozen
 *  elapsed, and the claim ended with it. */
export function resolveMapInterlude(ctx: EngineContext, emit: EmitFn): void {
  const claimed = ctx.registry.mapInterludeAt !== null;
  ctx.registry.releaseMapInterlude();
  if (claimed && !ctx.paused) ctx.registry.resumeMap(emit);
}
