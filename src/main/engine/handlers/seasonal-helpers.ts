/**
 * Shared helpers for seasonal mechanic handlers.
 *
 * All three seasonal handlers (Dream, Vorex, Overrealm) write to the same
 * ctx.seasonal slot. These helpers centralise start/finish so each handler
 * doesn't duplicate that logic.
 */
import {Tracker} from '@/main/engine/tracker';
import type {SeasonalType} from '@/main/engine/tracker';
import type {EngineContext} from '@/main/engine/context';
import type {EmitFn} from '@/main/engine/types';

export function startSeasonal(type: SeasonalType, ctx: EngineContext, emit: EmitFn): void {
  // If a different seasonal type is already running, finish it first.
  if (ctx.seasonal && ctx.seasonal.seasonalType !== type) {
    finishSeasonal(ctx, emit);
  }
  if (!ctx.seasonal) {
    ctx.seasonal = new Tracker('seasonal', type);
    emit({type: 'tracker_started', tracker: ctx.seasonal.snapshot(), timestamp: Date.now()});
  }
}

export function finishSeasonal(ctx: EngineContext, emit: EmitFn): void {
  if (!ctx.seasonal) return;
  const snap   = ctx.seasonal.snapshot();
  ctx.seasonal = null;
  emit({type: 'tracker_finished', tracker: snap, timestamp: Date.now()});
}
