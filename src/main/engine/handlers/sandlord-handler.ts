import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {pauseMapForInterlude, resolveMapInterlude} from '@/main/engine/map-interlude';
import {SANDLORD_HUB_SCENE, TOWN_SCENE} from '@/shared/scenes';

/**
 * SandlordHandler — Sandlord (S10) translator.
 *
 * Pure zone-transition trigger. Entering the seasonal hub starts a bubble
 * seasonal that absorbs hub + sub-maps into one tracker (no per-map trackers
 * are created inside: ZoneHandler resolves the sub-maps to the hub, and
 * `registry.startMap()` refuses while a bubble is up).
 *
 * Must be registered BEFORE ZoneHandler so the bubble is in the registry by
 * the time Zone runs on the same event — hence it reads scene names, never
 * `ctx.location`, which Zone has not updated yet.
 */
export class SandlordHandler implements EventHandler {
  readonly name    = 'sandlord';
  readonly handles = ['zone_transition'] as const;

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'zone_transition') return;
    if (ctx.phase !== 'tracking') return;

    const enteringHub  = event.toScene.includes(SANDLORD_HUB_SCENE);
    const enteringTown = event.toScene.includes(TOWN_SCENE);
    const existing     = ctx.registry.seasonal('sandlord');
    // Only a HUB run blocks a fresh bubble. A dormant map-phase tile run shares
    // the seasonal type but is a different mechanic, and can linger across a
    // direct map → hub transition — counting it here would suppress the bubble.
    const inHubRun = existing !== null && existing.phase !== 'map';

    // Entering the hub starts a bubble seasonal — while the session is paused
    // too, frozen like a map entered while paused, so the session resume
    // starts its clock. A direct map → hub transition is possible: the map
    // freezes for the whole Sandlord run (it ends at town with the Sandlord
    // time excluded).
    if (enteringHub && !inHubRun) {
      // Retire a map-phase run first so the type is free for the bubble.
      if (existing) existing.finish();
      pauseMapForInterlude(ctx, emit);
      const run = ctx.registry.startSeasonal({type: 'sandlord', ownsBubble: true, phase: 'hub'}, emit);
      if (run && ctx.paused) ctx.registry.freezeForSessionPause(run);
      return;
    }

    // Entering town finishes the bubble — structural teardown, must run while
    // paused so the run doesn't hang (mirrors ZoneHandler's town-entry teardown,
    // which for the bubble case is skipped because ctx.inMap is false). Also
    // resolves a map→hub interlude; ZoneHandler (registered after us) then
    // finishes that map off its frozen elapsed... unless it was resumed here a
    // tick earlier — same timestamp, zero accrual, harmless either way.
    // A map-phase run is NOT ours to tear down — ZoneHandler.finishAll owns it,
    // and it never froze a map, so resolveMapInterlude would wrongly un-freeze.
    if (inHubRun && enteringTown) {
      resolveMapInterlude(ctx, emit);
      existing?.finish();
    }
  }
}
