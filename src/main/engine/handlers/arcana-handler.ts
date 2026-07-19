import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {pauseMapForInterlude, resolveMapInterlude} from '@/main/engine/map-interlude';

const ARCANA_SCENE = 'SuMingTaLuo';

/**
 * ArcanaHandler — Arcana (S9 "Tarot" / Fateful Contest) translator.
 *
 * The mechanic has two phases: a Tarot Path minigame (opened in town or on a
 * netherrealm map) followed by the Fateful Contest fight in scene
 * `SuMingTaLuo000`. The timer starts at the minigame and continues into the
 * fight; the run finishes when the player leaves the fight scene.
 *
 *   s9_minigame     : Tarot Path opened/reopened — start (or resume if paused)
 *   s9_fight        : Fateful Contest fight begins — start/resume/continue
 *   s9_close        : player backed out of the Tarot panel — pause the tracker
 *                     (kept alive; a later s9_minigame/s9_fight resumes it,
 *                     town entry finishes it via ZoneHandler.finishAll)
 *   zone_transition : entering the fight scene pauses any running map tracker;
 *                     leaving it resumes the map (if returning to one) and
 *                     finishes the arcana tracker.
 *
 * `SuMingTaLuo000` lives under /Game/Art/Season/, which ZoneHandler's
 * classifyScene() treats as a seasonal scene (not a generic map) so no map
 * tracker is created on top of this one — see zone.ts. But a map tracker may
 * already be running when the fight is entered from a map (Tarot opened
 * mid-map); that map is paused for the duration of the fight and resumed when
 * the player zones back into it. The player always returns to the exact map
 * scene they left (verified against real logs).
 */
export class ArcanaHandler implements EventHandler {
  readonly name    = 'arcana';
  readonly handles = ['s9_minigame', 's9_fight', 's9_close', 'zone_transition'] as const;

  onStop(ctx: EngineContext): void {
    ctx.mapPausedForInterludeAt = null;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;

    switch (event.type) {
      // --- Crediting / start events: inert while the session is paused. -----
      // Starting or resuming the arcana tracker during a pause would let it (and
      // possibly a fresh map) start accruing; the run must not advance while
      // paused. ItemHandler already suppresses drops.
      case 's9_minigame':
      case 's9_fight': {
        if (ctx.paused) break;
        // Panel interlude begins — a running map freezes for its whole
        // duration (minigame AND fight). Backing out or leaving resolves it.
        pauseMapForInterlude(ctx, emit);
        ctx.registry.activateSeasonal({type: 'arcana'}, emit);
        break;
      }
      case 's9_close':
        // Map bookkeeping is structural — the panel IS closed, so resolve the
        // interlude even while session-paused.
        resolveMapInterlude(ctx, emit);
        if (ctx.paused) break;
        // Backed out of the Tarot panel without fighting — pause the run.
        ctx.registry.seasonal('arcana')?.pauseTracker();
        break;

      // --- Structural: MUST run even while paused. --------------------------
      // The fight-pause bookkeeping (map pause/resume) must resolve on scene
      // changes regardless of session-pause state, or a map paused for a fight
      // stays permanently paused after the player leaves. Crediting is still
      // frozen: the map tracker is paused, and while the session is paused we
      // leave it paused for Engine.resume() to bring back.
      case 'zone_transition': {
        const enteringFight = !event.fromScene.includes(ARCANA_SCENE) && event.toScene.includes(ARCANA_SCENE);
        const leavingFight  = event.fromScene.includes(ARCANA_SCENE) && !event.toScene.includes(ARCANA_SCENE);

        if (enteringFight) {
          // Usually a no-op (map frozen since the minigame opened); covers a
          // fight entered without a tracked minigame.
          pauseMapForInterlude(ctx, emit);
        } else if (leavingFight) {
          resolveMapInterlude(ctx, emit);
          ctx.registry.seasonal('arcana')?.finish();
        }
        break;
      }
    }
  }
}
