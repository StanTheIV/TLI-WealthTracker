import type {RawEvent} from '@/worker/processors/types';
import type {EngineContext} from './context';
import type {EngineEvent} from '@/shared/contracts/engine';

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------

/** A `unit_finished` as the registry builds it: the Engine adds the
 *  `checkpoint` on its way out (the session counters live on the context). */
export type UnstampedUnit = Omit<Extract<EngineEvent, {type: 'unit_finished'}>, 'checkpoint'>;

/** What the engine's internals emit — every EngineEvent, with units unstamped. */
export type InternalEvent = Exclude<EngineEvent, {type: 'unit_finished'}> | UnstampedUnit;

/** The emitter handed to handlers, trackers and the registry. */
export type EmitFn = (event: InternalEvent) => void;

/** The Engine's outlet: finished EngineEvents only. */
export type EngineSink = (event: EngineEvent) => void;

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
  /** Read this handler's keys from the raw settings table; a missing or
   *  unparseable value falls back to the handler's default. A new value only
   *  affects runs started after it — a live tracker keeps its window. */
  configure?(settings: Readonly<Record<string, string>>): void;
}
