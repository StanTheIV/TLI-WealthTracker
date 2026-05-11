import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {log} from '@/main/logger';

const TOWN_MARKER = 'YuJinZhiXiBiNanSuo';

function classifyScene(scene: string): 'map' | 'town' | 'unknown' {
  if (scene.includes(TOWN_MARKER)) return 'town';
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
    if (ctx.paused) return;

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
      ctx.mapStartTime = now;
      const map = ctx.registry.startMap();
      if (map && ctx.phase === 'tracking') {
        log.debug('session', `Map started: count=${ctx.mapCount}`);
        emit({type: 'map_started', mapCount: ctx.mapCount, timestamp: now});
        emit({type: 'tracker_started', tracker: map.snapshot(), timestamp: now});
      }
    } else if (entering === 'town' && ctx.inMap) {
      const elapsed = now - ctx.mapStartTime;
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
    }

    ctx.currentScene = event.toScene;
  }
}
