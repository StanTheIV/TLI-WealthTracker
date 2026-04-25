import type {RawEvent} from '@/worker/processors/types';
import type {EngineContext} from './context';
import type {TrackerSnapshot} from './tracker';

export type {TrackerSnapshot};

// ---------------------------------------------------------------------------
// EngineEvents — sent to renderer via IPC
// ---------------------------------------------------------------------------

// Keep in sync with src/types/electron.d.ts
export type EngineEvent =
  | {type: 'init_started'}
  | {type: 'init_complete'; itemCount: number}
  | {type: 'drop';             itemId: number; change: number; timestamp: number}
  | {type: 'new_item';         itemId: number; timestamp: number}
  | {type: 'zone_change';      from: string; to: string; entering: 'map' | 'town' | 'unknown'; timestamp: number}
  | {type: 'map_started';      mapCount: number; timestamp: number}
  | {type: 'map_ended';        elapsed: number; timestamp: number}
  | {type: 'tracker_started';  tracker: TrackerSnapshot; timestamp: number; sessionMeta?: {mapTime: number; mapCount: number}}
  | {type: 'tracker_update';   tracker: TrackerSnapshot; timestamp: number}
  | {type: 'tracker_finished'; tracker: TrackerSnapshot; timestamp: number; sessionMeta?: {mapTime: number; mapCount: number}}
  | {type: 'session_status';   status: 'running' | 'paused'; elapsed: number; timestamp: number}
  | {type: 'session_saved';    sessionId: string}
  | {type: 'price_update';     itemId: number; price: number; timestamp: number}
  | {type: 'wealth_recorded';  timestamp: number}
  | {type: 'map_material_warning'; items: Array<{itemId: number; quantity: number}>; timestamp: number}
  | {type: 'error';            message: string};

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
