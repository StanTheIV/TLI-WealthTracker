import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const LEVEL_TYPE_MAP   = 3;
const LEVEL_TYPE_DREAM = 11;

/**
 * DreamHandler — Dream (S5) translator.
 *
 *   level_type 3 → 11  : enter Dream, start seasonal tracker
 *   level_type 11 → 3  : exit Dream, finish seasonal tracker
 */
export class DreamHandler implements EventHandler {
  readonly name    = 'dream';
  readonly handles = ['level_type'] as const;

  // Last seen level_type, tracked in every phase so a session that opens
  // inside a Dream knows it (onSessionOpen). Default 3 (map) so a fresh start
  // that lands on level_type=11 is detected as a transition out of map.
  private _levelType: number = LEVEL_TYPE_MAP;

  onStart(): void {
    this._levelType = LEVEL_TYPE_MAP;
  }

  onStop(): void {
    this._levelType = LEVEL_TYPE_MAP;
  }

  /** The session opened inside a Dream: its run starts fresh (in-map, so the
   *  map keeps running) and ends on the usual 11 → 3. Frozen with the session
   *  if it is paused, so the session resume starts its clock. */
  onSessionOpen(ctx: EngineContext, emit: EmitFn): void {
    if (this._levelType !== LEVEL_TYPE_DREAM) return;
    const run = ctx.registry.startSeasonal({type: 'dream'}, emit);
    if (run && ctx.paused) ctx.registry.freezeForSessionPause(run);
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'level_type') return;

    const oldType = this._levelType;
    this._levelType = event.levelType;
    if (ctx.phase !== 'tracking') return;
    if (oldType === event.levelType) return;

    if (oldType === LEVEL_TYPE_MAP && event.levelType === LEVEL_TYPE_DREAM) {
      // Entering Dream is a crediting start — inert while paused (don't spin up
      // a new tracker that would accrue during the pause). We still tracked the
      // level_type above so state stays coherent on resume.
      if (ctx.paused) return;
      ctx.registry.startSeasonal({type: 'dream'}, emit);
    } else if (oldType === LEVEL_TYPE_DREAM && event.levelType === LEVEL_TYPE_MAP) {
      // Exiting Dream is structural teardown of an active run — must finish even
      // while paused so the seasonal doesn't hang paused indefinitely. finish()
      // is idempotent; the tracker is paused so no elapsed accrues either way.
      ctx.registry.seasonal('dream')?.finish();
    }
  }
}
