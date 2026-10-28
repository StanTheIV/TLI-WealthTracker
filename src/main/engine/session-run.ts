import type {EngineContext} from './context';
import type {Tracker} from './tracker';
import type {EmitFn} from './types';

/**
 * Open the session run: the one place a session tracker is born — bag-init
 * completion (fresh or continued) and Engine.reset. The caller has already
 * torn the previous trackers down.
 *
 * The counters start over: the loaded values on a continue (else zero), plus
 * the map the player is inside, if any —
 *   mapCount = (loaded ?? 0) + (inMap ? 1 : 0),  mapTime = loaded ?? 0.
 * That map is rebuilt as a fresh tracker, so only time and loot from here on
 * are its; it keeps `carriedCost`, the materials consumed to open it.
 *
 * Emits the session tracker_started (identity + counters), then for a rebuilt
 * map its map_started and tracker_started, and a session update when the
 * carried cost changed the session's spent.
 *
 * Last, the handlers' session-open hooks (EventHandler.onSessionOpen): an
 * interlude still in progress — seen by its handler, but with no session to
 * run in (pre-init) or its run just discarded (Reset) — starts fresh and
 * re-freezes the rebuilt map, which is why the hooks run after it.
 */
export function openSessionRun(
  ctx: EngineContext,
  emit: EmitFn,
  now: number,
  carriedCost: ReadonlyMap<number, number>,
): Tracker {
  const sessionId = ctx.activeSessionId;
  const name      = ctx.activeSessionName;
  if (sessionId === null || name === null) {
    throw new Error('openSessionRun: no session identity — Engine.start / Engine.reset set it');
  }
  const loaded = ctx.loadedSession;
  ctx.loadedSession    = null;
  ctx.sessionContinued = loaded !== null;

  const session = ctx.registry.startSession();
  if (loaded) {
    session.seed({
      drops:         loaded.drops,
      dropsBySource: loaded.dropsBySource,
      spent:         loaded.spent,
      timeOffsetMs:  loaded.totalTime * 1000,
    });
  }
  if (ctx.paused) session.pause();

  ctx.mapCount           = (loaded?.mapCount ?? 0) + (ctx.inMap ? 1 : 0);
  ctx.accumulatedMapTime = (loaded?.mapTime ?? 0) * 1000;
  emit({
    type:        'tracker_started',
    tracker:     session.snapshot(),
    timestamp:   now,
    sessionMeta: {
      sessionId,
      name,
      continued: ctx.sessionContinued,
      mapTime:   ctx.accumulatedMapTime,
      mapCount:  ctx.mapCount,
    },
  });

  if (ctx.inMap) {
    const map = ctx.registry.startMap();
    if (map) {
      if (ctx.paused) map.pause();
      ctx.registry.chargeEntryCost(carriedCost);
      emit({type: 'map_started', mapCount: ctx.mapCount, timestamp: now});
      emit({type: 'tracker_started', tracker: map.snapshot(), timestamp: now});
      if (carriedCost.size > 0) {
        emit({type: 'tracker_update', tracker: session.snapshot(), timestamp: now});
      }
    }
  }

  for (const hook of ctx.sessionOpenHooks) hook(ctx, emit);
  return session;
}
