import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {pauseMapForInterlude, resolveMapInterlude} from '@/main/engine/map-interlude';

const TARTARUS_FIGHT_ZONE = 'ZhongZuiDiYu';

/**
 * TartarusHandler — Tartarus (S16) translator. Board minigame ("Warden's Duty",
 * town or mid-map) → Riot checkout → Suppress into the prison fight/loot scene.
 * The run's clock covers board + fight.
 *
 *   s16_board_open (settled)   : replay of the previous board's checkout — inert
 *   s16_board_open (live)      : start (or resume after Esc) tracker
 *   s16_suppress               : commit; the fight zone follows
 *   s16_ignore                 : abandon a live board → finish (0-drop run)
 *   s16_board_close            : Esc mid-board → pause tracker
 *   zone_transition            : prison entry/exit; unresolved commit → finish
 */
export class TartarusHandler implements EventHandler {
  readonly name    = 'tartarus';
  readonly handles = ['s16_board_open', 's16_board_close', 's16_suppress', 's16_ignore', 'zone_transition'] as const;

  // Every device open first replays the last settled board's checkout; its
  // Ignore/close are a dismissal, not part of any run.
  private _viewingSettled = false;
  // Suppress clicked; the board closes and the prison scene loads next.
  private _committed = false;

  onStop(): void {
    this._viewingSettled = false;
    this._committed      = false;
  }

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;

    switch (event.type) {
      case 's16_board_open': {
        this._viewingSettled = event.settled;
        if (event.settled) break;
        // Crediting start/resume — inert while the session is paused.
        if (ctx.paused) break;
        // The board is a panel interlude — a running map freezes while it's
        // open (no-op from town).
        pauseMapForInterlude(ctx, emit);
        ctx.registry.activateSeasonal({type: 'tartarus'}, emit);
        break;
      }
      case 's16_suppress':
        if (!this._viewingSettled) this._committed = true;
        break;
      case 's16_ignore':
        if (this._viewingSettled) break;
        // Structural: the riot was abandoned, no fight follows. Runs while
        // paused so the run doesn't hang; it keeps its board time, 0 drops.
        resolveMapInterlude(ctx, emit);
        ctx.registry.seasonal('tartarus')?.finish();
        break;
      case 's16_board_close':
        if (this._viewingSettled) {
          this._viewingSettled = false;
          break;
        }
        // Committed: the prison scene is next — map stays frozen, clock runs.
        if (this._committed) break;
        // Structural: the board IS closed — the player is back on the map.
        resolveMapInterlude(ctx, emit);
        if (ctx.paused) break;
        ctx.registry.seasonal('tartarus')?.pauseTracker();
        break;
      case 'zone_transition': {
        const enteringFight = !event.fromScene.includes(TARTARUS_FIGHT_ZONE) && event.toScene.includes(TARTARUS_FIGHT_ZONE);
        const leavingFight  = event.fromScene.includes(TARTARUS_FIGHT_ZONE) && !event.toScene.includes(TARTARUS_FIGHT_ZONE);
        const committed = this._committed;
        this._committed = false;

        if (enteringFight) {
          // The fight is part of the interlude. Activation also self-heals a
          // run whose board opened before the session started.
          pauseMapForInterlude(ctx, emit);
          if (ctx.paused) break;
          ctx.registry.activateSeasonal({type: 'tartarus'}, emit);
        } else if (leavingFight) {
          // To town: ZoneHandler already finished everything — both calls are
          // no-ops. Back to a map: the map resumes and the run ends here.
          resolveMapInterlude(ctx, emit);
          ctx.registry.seasonal('tartarus')?.finish();
        } else if (committed) {
          // Suppress that never reached the prison — don't leave it hanging.
          resolveMapInterlude(ctx, emit);
          ctx.registry.seasonal('tartarus')?.finish();
        }
        break;
      }
    }
  }
}
