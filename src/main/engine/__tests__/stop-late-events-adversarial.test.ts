import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import {ARCANA_FIGHT, MAP, SANDLORD_HUB, TOWN, createDispatcher, createEngine, ctx, feed, log} from './seasonal-fixtures';
import {INV, LOOT} from './interlude-fixtures';
import {beginSession, completeInit} from './identity-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Nothing may leave the engine after engine_stopped, however long the timers run. */
function expectSilentAfterStop(events: EngineEvent[]): void {
  const at = events.length;
  expect(events[at - 1].type).toBe('engine_stopped');
  vi.advanceTimersByTime(120_000);
  expect(events.slice(at).map(e => e.type)).toEqual([]);
}

describe('no event follows engine_stopped', () => {
  it('stop while the bag baseline debounce is pending', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    const d = createDispatcher();
    beginSession(e);
    for (const {slotId, itemId, quantity} of INV) feed(d, e, log.bagInit(slotId, itemId, quantity));
    e.stop();
    expectSilentAfterStop(events);
    expect(ctx(e).phase).toBe('idle');
  });

  it('stop during an interlude with a pending loot window / timers', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    const d = createDispatcher();
    beginSession(e);
    completeInit(d, e, INV);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.bagUpdate(1, LOOT, 1));
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT));
    vi.advanceTimersByTime(2_000);
    feed(d, e, log.bagUpdate(1, LOOT, 3));
    e.stop();
    expectSilentAfterStop(events);
  });

  it('stop while paused in a Sandlord hub', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    const d = createDispatcher();
    beginSession(e);
    completeInit(d, e, INV);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    vi.advanceTimersByTime(1_000);
    e.pause();
    e.stop();
    expectSilentAfterStop(events);
  });

  it('zone, drop and timer activity after stop emits nothing but zone_change', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    const d = createDispatcher();
    beginSession(e);
    completeInit(d, e, INV);
    e.stop();
    const at = events.length;
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.bagUpdate(1, LOOT, 5));
    vi.advanceTimersByTime(10_000);
    expect(events.slice(at).map(x => x.type).filter(t => t !== 'zone_change')).toEqual([]);
  });
});
