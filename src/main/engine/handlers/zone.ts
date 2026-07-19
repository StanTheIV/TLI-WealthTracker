import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {log} from '@/main/logger';

const TOWN_MARKER = 'YuJinZhiXiBiNanSuo';

// Seasonal scenes that live under /Game/Art/Season/ but are owned by a
// seasonal handler, not a generic map tracker. Classifying them as 'map'
// would spin up a phantom map tracker on top of the seasonal one and
// double-count drops. Each entry must correspond to a seasonal that manages
// its own tracker lifecycle via its own log markers:
//   SuMingTaLuo  — Arcana (S9) Fateful Contest scene, owned by ArcanaHandler.
//   DiXiaZhenSuo — Vorex  (S13) reward zone, owned by VorexHandler.
// (Sandlord's S10 scene isn't listed here — it owns a bubble, and the
//  hasBubble() guard below already suppresses the map tracker for it.)
const SEASONAL_SCENE_MARKERS = ['SuMingTaLuo', 'DiXiaZhenSuo'];

function classifyScene(scene: string): 'map' | 'town' | 'unknown' {
  if (scene.includes(TOWN_MARKER)) return 'town';
  if (SEASONAL_SCENE_MARKERS.some((m) => scene.includes(m))) return 'unknown';
  if (scene.includes('/Game/Art/Maps/') || scene.includes('/Game/Art/Season/')) return 'map';
  return 'unknown';
}

function shortScene(scene: string): string {
  const parts = scene.split('/');
  return parts[parts.length - 1] || scene;
}

/**
 * ZoneHandler — tracks scene transitions and map lifecycle.
 *
 * Must be registered BEFORE seasonal handlers and ItemHandler so ctx.inMap is
 * updated before those handlers read it on the same zone_transition event.
 *
 * Exception: bubble-owning seasonal handlers (e.g. SandlordHandler) must run
 * BEFORE ZoneHandler so the bubble seasonal is in the registry by the time
 * Zone reads it on map-entry.
 */
export class ZoneHandler implements EventHandler {
  readonly name    = 'zone';
  readonly handles = ['zone_transition'] as const;

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'zone_transition') return;
    // NOTE: we deliberately do NOT bail on ctx.paused. Zone transitions are
    // STRUCTURAL, not crediting: the state machine must keep observing scene
    // changes while the session is paused so a map/seasonal that ends mid-pause
    // still finishes and currentScene stays accurate. Crediting is already
    // suppressed independently — the trackers are paused (elapsed frozen, drops
    // rejected) and ItemHandler discards its buffer while paused. Map-time
    // accounting below excludes the still-open paused span so a pause-spanning
    // map doesn't fold paused wall-clock into accumulatedMapTime.

    const entering = classifyScene(event.toScene);
    const now = Date.now();

    emit({
      type: 'zone_change',
      from: shortScene(event.fromScene),
      to:   shortScene(event.toScene),
      entering,
      timestamp: now,
    });

    if (entering === 'map' && !ctx.inMap && !ctx.registry.hasBubble()) {
      ctx.inMap        = true;
      ctx.mapCount    += 1;
      const map = ctx.registry.startMap();
      if (map && ctx.phase === 'tracking') {
        // Started a fresh map while the session is paused: freeze it so it
        // doesn't accrue elapsed during the remaining pause. Engine.resume()
        // un-freezes any non-fight-paused map. Its own elapsed() (0 for now)
        // is what town-entry accounting reads, so no time bookkeeping is needed.
        if (ctx.paused) map.pause();
        log.debug('session', `Map started: count=${ctx.mapCount}`);
        emit({type: 'map_started', mapCount: ctx.mapCount, timestamp: now});
        emit({type: 'tracker_started', tracker: map.snapshot(), timestamp: now});
      }
    } else if (entering === 'town' && ctx.inMap) {
      // The map tracker's OWN elapsed is the authoritative map time: it is
      // paused during interludes AND session pauses, so both are already
      // excluded — no wall-clock arithmetic. (finishAll below runs after the
      // read; inMap ⇒ a map tracker exists, ?? 0 is pure type safety.)
      const elapsed = ctx.registry.map?.elapsed() ?? 0;
      ctx.accumulatedMapTime += elapsed;

      // Finish all seasonals (each cancels its loot timer + emits tracker_finished)
      // then the map tracker. SessionPersistence sees the seasonals first while
      // the map tracker is still alive, so each becomes an overlap row tied to
      // the current parent map.
      ctx.registry.finishAll(emit);

      ctx.inMap = false;
      if (ctx.phase === 'tracking') {
        log.debug('session', `Map ended: elapsed=${elapsed}ms`);
        emit({type: 'map_ended', elapsed, timestamp: now});
      }
    } else if (entering === 'town' && ctx.registry.seasonalsSize() > 0) {
      // Returned to town while a seasonal is live but no map tracker was ever
      // started (e.g. town -> Vorex/Arcana -> town — the seasonal scene is
      // classified 'unknown', so ctx.inMap stays false and the branch above is
      // skipped). Still finish the seasonals so the run ends. No map-time
      // accumulation or map_ended here — there was no map.
      ctx.registry.finishAllSeasonals();
    }

    ctx.currentScene = event.toScene;
  }
}
