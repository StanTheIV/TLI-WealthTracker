import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

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
 *   zone_transition : leaving the Arcana fight scene finishes the tracker
 *
 * `SuMingTaLuo000` lives under /Game/Art/Season/, which ZoneHandler's
 * classifyScene() treats as a seasonal scene (not a generic map) so no map
 * tracker is created on top of this one — see zone.ts.
 */
export class ArcanaHandler implements EventHandler {
  readonly name    = 'arcana';
  readonly handles = ['s9_minigame', 's9_fight', 'zone_transition'] as const;

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking' || ctx.paused) return;

    switch (event.type) {
      case 's9_minigame':
      case 's9_fight': {
        const existing = ctx.registry.seasonal('arcana');
        if (existing && !existing.active) existing.resumeTracker();
        else                              ctx.registry.startSeasonal({type: 'arcana'}, emit);
        break;
      }
      case 'zone_transition':
        // Leaving the Fateful Contest scene ends the run.
        if (event.fromScene.includes(ARCANA_SCENE) && !event.toScene.includes(ARCANA_SCENE)) {
          ctx.registry.seasonal('arcana')?.finish();
        }
        break;
    }
  }
}
