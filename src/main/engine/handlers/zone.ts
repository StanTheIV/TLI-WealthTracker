import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext, Location} from '@/main/engine/context';
import type {EngineEvent} from '@/shared/contracts/engine';
import {log} from '@/main/logger';
import {MAP_SCENE_PREFIXES, SANDLORD_HUB_SCENE, SEASONAL_SCENE_MARKERS, TOWN_SCENE} from '@/shared/scenes';

type ZoneEntering = Extract<EngineEvent, {type: 'zone_change'}>['entering'];

/** A scene on its own. The hub is listed before the map prefixes it also matches. */
function classifyScene(scene: string): Location {
  if (scene.includes(TOWN_SCENE)) return 'town';
  if (SEASONAL_SCENE_MARKERS.some((m) => scene.includes(m))) return 'seasonal-scene';
  if (scene.includes(SANDLORD_HUB_SCENE)) return 'hub';
  if (MAP_SCENE_PREFIXES.some((p) => scene.includes(p))) return 'map';
  return 'other';
}

/** The hub is sticky: a map scene entered from the hub is one of its sub-maps. */
function resolveLocation(scene: string, fromHub: boolean): Location {
  const cls = classifyScene(scene);
  return fromHub && cls === 'map' ? 'hub' : cls;
}

/** The renderer's coarser `zone_change.entering` vocabulary (the hub and its
 *  sub-maps read as maps, seasonal and unrecognised scenes as unknown). */
const ENTERING: Record<Location, ZoneEntering> = {
  'town':           'town',
  'map':            'map',
  'hub':            'map',
  'seasonal-scene': 'unknown',
  'other':          'unknown',
};

function shortScene(scene: string): string {
  const parts = scene.split('/');
  return parts[parts.length - 1] || scene;
}

/**
 * ZoneHandler — tracks scene transitions and map lifecycle, and is the only
 * writer of `ctx.location` / `prevLocation` / `transition`.
 *
 * Must be registered BEFORE seasonal handlers and ItemHandler so ctx.inMap and
 * ctx.location are updated before those handlers read them on the same
 * zone_transition event.
 *
 * Exception: SandlordHandler runs BEFORE ZoneHandler (it resolves the hub
 * interlude before Zone's town branch finishes the map, and its bubble makes
 * startMap() refuse) — so it must not read ctx.location / transition, which
 * would still describe the previous transition.
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

    // Location first, before any branch. `from` comes from the scene, so the
    // first transition after start (location still the initial 'other') is
    // right too; only the hub's stickiness needs the current location.
    const from = resolveLocation(event.fromScene, ctx.location === 'hub');
    const to   = resolveLocation(event.toScene, from === 'hub');
    ctx.prevLocation = from;
    ctx.location     = to;

    const now = Date.now();

    emit({
      type: 'zone_change',
      from: shortScene(event.fromScene),
      to:   shortScene(event.toScene),
      entering: ENTERING[classifyScene(event.toScene)],
      timestamp: now,
    });

    // The hub never starts a map: its sub-maps resolve to 'hub'. startMap()
    // still refuses while a bubble is up (a seasonal-scene detour out of the
    // hub loses the stickiness), and the run is only counted once it exists.
    const map = to === 'map' && !ctx.inMap ? ctx.registry.startMap() : null;
    if (map) {
      ctx.inMap     = true;
      ctx.mapCount += 1;
      if (ctx.phase === 'tracking') {
        // Started a fresh map while the session is paused: freeze it so it
        // doesn't accrue elapsed during the remaining pause. Engine.resume()
        // un-freezes any non-fight-paused map. Its own elapsed() (0 for now)
        // is what town-entry accounting reads, so no time bookkeeping is needed.
        if (ctx.paused) map.pause();
        log.debug('session', `Map started: count=${ctx.mapCount}`);
        emit({type: 'map_started', mapCount: ctx.mapCount, timestamp: now});
        emit({type: 'tracker_started', tracker: map.snapshot(), timestamp: now});
      }
    } else if (to === 'town' && ctx.inMap) {
      // The map tracker's OWN elapsed is the authoritative map time: it is
      // paused during interludes AND session pauses, so both are already
      // excluded — no wall-clock arithmetic. (finishAll below runs after the
      // read; inMap ⇒ a map tracker exists, ?? 0 is pure type safety.)
      const elapsed = ctx.registry.map?.elapsed() ?? 0;
      ctx.accumulatedMapTime += elapsed;

      // Finish all seasonals (each cancels its loot timer + emits tracker_finished)
      // then the map tracker, whose unit_finished carries the map's children.
      ctx.registry.finishAll(emit);

      ctx.inMap = false;
      if (ctx.phase === 'tracking') {
        log.debug('session', `Map ended: elapsed=${elapsed}ms`);
        emit({type: 'map_ended', elapsed, timestamp: now});
      }
    } else if (to === 'town' && ctx.registry.seasonalsSize() > 0) {
      // Returned to town while a seasonal is live but no map tracker was ever
      // started (e.g. town -> Vorex/Arcana -> town — a seasonal scene is not a
      // map, so ctx.inMap stays false and the branch above is skipped). Still
      // finish the seasonals so the run ends. No map-time accumulation or
      // map_ended here — there was no map.
      ctx.registry.finishAllSeasonals();
    }

    ctx.transition   = {from, to, mapStarted: map !== null};
    ctx.currentScene = event.toScene;
  }
}
