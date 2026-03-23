import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import {startSeasonal, finishSeasonal} from './seasonal-helpers';

const LEVEL_TYPE_MAP   = 3;
const LEVEL_TYPE_DREAM = 11;

/**
 * DreamHandler — manages the Dream (S5) seasonal tracker lifecycle.
 *
 * Dream entry/exit is detected via PreloadLevelType transitions:
 *   3 (map) → 11 (dream) : enter Dream, start seasonal tracker
 *   11 (dream) → 3 (map) : exit Dream, finish seasonal tracker
 *
 * Must be registered AFTER ZoneHandler and BEFORE ItemHandler.
 */
export class DreamHandler implements EventHandler {
  readonly name    = 'dream';
  readonly handles = ['level_type'] as const;

  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void {
    if (ctx.phase !== 'tracking') return;
    if (ctx.paused) return;
    if (event.type !== 'level_type') return;

    const oldType = ctx.levelType;
    ctx.levelType = event.levelType;
    if (oldType === event.levelType) return;

    if (oldType === LEVEL_TYPE_MAP && event.levelType === LEVEL_TYPE_DREAM) {
      startSeasonal('dream', ctx, emit);
    } else if (oldType === LEVEL_TYPE_DREAM && event.levelType === LEVEL_TYPE_MAP) {
      finishSeasonal(ctx, emit);
    }
  }
}
