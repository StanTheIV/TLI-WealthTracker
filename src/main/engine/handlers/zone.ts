import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {Tracker} from '@/main/engine/tracker';
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
 * Must be registered BEFORE SeasonalHandler and ItemHandler so ctx.inMap is
 * updated before those handlers read it on the same zone_transition event.
 *
 * Exception: SandlordHandler must run BEFORE ZoneHandler, because Zone reads
 * ctx.inSandlord (set by SandlordHandler) on the same event to decide whether
 * to suppress map-tracker creation inside the Sandlord bubble.
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

    if (entering === 'map' && !ctx.inMap && !ctx.inSandlord) {
      ctx.inMap        = true;
      ctx.mapCount    += 1;
      ctx.mapStartTime = now;
      ctx.map          = new Tracker('map');
      if (ctx.phase === 'tracking') {
        log.debug('session', `Map started: count=${ctx.mapCount}`);
        emit({type: 'map_started', mapCount: ctx.mapCount, timestamp: now});
        emit({type: 'tracker_started', tracker: ctx.map.snapshot(), timestamp: now});
      }
    } else if (entering === 'town' && ctx.inMap) {
      const elapsed = now - ctx.mapStartTime;
      ctx.accumulatedMapTime += elapsed;

      // Finish seasonal first (seasonal drops in this map are already attributed)
      if (ctx.seasonal) {
        const snap = ctx.seasonal.snapshot();
        ctx.seasonal = null;
        emit({type: 'tracker_finished', tracker: snap, timestamp: now});
      }

      // Finish map tracker
      if (ctx.map) {
        const snap = ctx.map.snapshot();
        ctx.map = null;
        emit({type: 'tracker_finished', tracker: snap, timestamp: now});
      }

      ctx.inMap = false; // ItemHandler reads this on the same event
      if (ctx.phase === 'tracking') {
        log.debug('session', `Map ended: elapsed=${elapsed}ms`);
        emit({type: 'map_ended', elapsed, timestamp: now});
      }
    }

    ctx.currentScene = event.toScene;
  }
}
