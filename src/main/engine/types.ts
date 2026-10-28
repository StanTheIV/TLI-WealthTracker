import type {RawEvent} from '@/worker/processors/types';
import type {EngineContext} from './context';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {Settings} from '@/shared/settings';

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
  /** The session just opened (bag-init completion or Engine.reset) — run at
   *  the end of openSessionRun, after the map rebuild. A handler whose run is
   *  still in progress (an interlude, a Dream) starts it fresh here, since
   *  nothing it saw before could start one: the session did not exist yet
   *  (pre-init), or the reset just discarded it. */
  onSessionOpen?(ctx: EngineContext, emit: EmitFn): void;
  /** Read this handler's fields from the parsed settings. A new value only
   *  affects runs started after it — a live tracker keeps its window. */
  configure?(settings: Settings): void;
}
