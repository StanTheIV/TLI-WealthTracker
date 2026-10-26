import type {RawEvent} from '@/worker/processors/types';
import type {EngineContext} from './context';
import type {EngineEvent} from '@/shared/contracts/engine';

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------

export type EmitFn = (event: EngineEvent) => void;

export interface EventHandler {
  readonly name: string;
  /** RawEvent types this handler wants to receive */
  readonly handles: ReadonlyArray<RawEvent['type']>;
  /** Process a matching event — may read/write ctx, may emit EngineEvents */
  handle(event: RawEvent, ctx: EngineContext, emit: EmitFn): void;
  /** Called once on engine start, before any events */
  onStart?(ctx: EngineContext, emit: EmitFn): void;
  /** Called on engine stop — must clean up any timers */
  onStop?(ctx: EngineContext): void;
}
