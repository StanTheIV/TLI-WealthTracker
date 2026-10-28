/**
 * Step 2.1b fixtures: the session-identity / checkpoint / seed API of the engine.
 * No `.test.ts` suffix on purpose (vitest only runs `*.test.ts`).
 */
import {vi} from 'vitest';
import type {Dispatcher} from '@/worker/dispatcher';
import type {Engine} from '@/main/engine/engine';
import type {LoadedSessionData} from '@/main/engine/context';
import type {EngineEvent, SessionIdentity, SessionStartMeta} from '@/shared/contracts/engine';
import {TEST_IDENTITY, feed, log} from './seasonal-fixtures';

/** A saved session as the store hands it back: its identity plus the run data
 *  `Engine.loadSession` takes (drops/spent item-id keyed, times in SECONDS). */
export interface SeedData extends SessionIdentity, LoadedSessionData {}

export type UnitEvent = Extract<EngineEvent, {type: 'unit_finished'}>;

export const startWith = (e: Engine, identity: SessionIdentity = TEST_IDENTITY) => e.start(identity);
export const resetWith = (e: Engine, identity: SessionIdentity) => e.reset(identity);

/** Start (optionally continuing `loaded`) and complete bag init with `inventory`. */
export function bootSession(
  dispatcher: Dispatcher,
  engine: Engine,
  inventory: Array<{slotId: number; itemId: number; quantity: number}>,
  opts: {identity?: SessionIdentity; loaded?: SeedData} = {},
): void {
  beginSession(engine, opts);
  completeInit(dispatcher, engine, inventory);
}

/** Start (optionally continuing) but do NOT feed the bag dump — phase stays
 *  `initializing`. A continue is `loadSession(run data)` then `start(identity)`,
 *  the saved session's own identity unless `identity` overrides it. */
export function beginSession(engine: Engine, opts: {identity?: SessionIdentity; loaded?: SeedData} = {}): void {
  if (opts.loaded) {
    const {sessionId, name, ...data} = opts.loaded;
    engine.loadSession(data);
    startWith(engine, opts.identity ?? {sessionId, name});
    return;
  }
  startWith(engine, opts.identity ?? TEST_IDENTITY);
}

/** BagInitHandler's init debounce: advancing exactly this much ends the boot
 *  at the instant the session opens, so the session's own clock reads 0. */
const INIT_DEBOUNCE_MS = 500;

/** Feed the bag dump and let BagInitHandler's debounce fire. */
export function completeInit(
  dispatcher: Dispatcher,
  engine: Engine,
  inventory: Array<{slotId: number; itemId: number; quantity: number}>,
): void {
  for (const {slotId, itemId, quantity} of inventory) feed(dispatcher, engine, log.bagInit(slotId, itemId, quantity));
  vi.advanceTimersByTime(INIT_DEBOUNCE_MS);
}

export const sessionStarts = (events: ReadonlyArray<EngineEvent>) =>
  events.filter((e): e is Extract<EngineEvent, {type: 'tracker_started'}> => e.type === 'tracker_started' && e.tracker.kind === 'session');

export const metaOf = (e: Extract<EngineEvent, {type: 'tracker_started'}>): SessionStartMeta => {
  if (!e.sessionMeta) throw new Error('session tracker_started without sessionMeta');
  return e.sessionMeta;
};

export const unitsWithCheckpoint = (events: ReadonlyArray<EngineEvent>) =>
  events.filter((e): e is UnitEvent => e.type === 'unit_finished');
