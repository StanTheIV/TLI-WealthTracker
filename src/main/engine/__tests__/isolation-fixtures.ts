/** Shared helpers for the 5.1c engine-isolation tests (no `.test.ts` suffix on purpose). */
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {EventHandler} from '@/main/engine/types';

export type ErrorEv = Extract<EngineEvent, {type: 'error'}>;

export const errorsOf = (events: ReadonlyArray<EngineEvent>): ErrorEv[] =>
  events.filter((e): e is ErrorEv => e.type === 'error');

/** A minimal handler with an explicit `name`; `hooks` override/extend it. */
export function stub(
  name: string,
  handles: ReadonlyArray<RawEvent['type']>,
  hooks: Partial<EventHandler> = {},
): EventHandler {
  return {name, handles, handle: () => undefined, ...hooks};
}

export function thrower(err: unknown): () => never {
  return () => { throw err; };
}
