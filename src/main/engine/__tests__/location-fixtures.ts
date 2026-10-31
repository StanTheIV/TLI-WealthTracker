/**
 * Shared helpers for the `ctx.location` tests (scene constants, crediting
 * observables, the resort path).
 *
 * Filename has no `.test.ts` suffix on purpose (see seasonal-fixtures.ts).
 */
import type {Engine} from '@/main/engine/engine';
import type {Dispatcher} from '@/worker/dispatcher';
import type {EngineEvent} from '@/shared/contracts/engine';
import {ctx, feed, log} from './seasonal-fixtures';

/** A scene no classifier recognises. */
export const UNKNOWN_SCENE = '/Game/Somewhere/Else/Nowhere.Nowhere';

/** The real `ItemChange@ Reset` line that precedes every bag dump. */
export const BAG_DUMP_START = '[2026.01.25-12.34.56:789]TLLua: Display: [Game] ItemChange@ Reset PageId=0';

/** Total of one item in the session tracker's drops (0 when absent). */
export function sessionDrops(e: Engine): Record<string, number> {
  return {...(ctx(e).registry.session?.snapshot().drops ?? {})};
}

export function dropsBySource(e: Engine): Record<string, Record<number, number>> {
  return {...(ctx(e).registry.session?.snapshot().dropsBySource ?? {})};
}

export const dropEvents = (events: EngineEvent[]) => events.filter(ev => ev.type === 'drop');

/** Apply a complete one-slot bag dump through the real processors (the resort path). */
export function resort(d: Dispatcher, e: Engine, slotId: number, itemId: number, quantity: number): void {
  feed(d, e, BAG_DUMP_START);
  feed(d, e, log.bagInit(slotId, itemId, quantity));
}
