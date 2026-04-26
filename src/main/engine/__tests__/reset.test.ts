/**
 * Tests for Engine.reset() — discards in-flight session/map/seasonal data
 * without re-initializing the bag or losing filter / known-item state.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Engine}             from '@/main/engine/engine';
import {BagInitHandler}     from '@/main/engine/handlers/bag-init';
import {ZoneHandler}        from '@/main/engine/handlers/zone';
import {ItemHandler}        from '@/main/engine/handlers/item';
import type {EngineEvent}   from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const TOWN_SCENE = 'XZ_YuJinZhiXiBiNanSuo200';
const MAP_SCENE  = '/Game/Art/Maps/S5_Boss';

function makeEngine(events: EngineEvent[]): Engine {
  return new Engine(e => events.push(e))
    .register(new BagInitHandler())
    .register(new ZoneHandler())
    .register(new ItemHandler());
}

function ctx(engine: Engine): EngineContext {
  return (engine as unknown as {_ctx: EngineContext})._ctx;
}

function boot(engine: Engine, items: Array<{slotId: number; itemId: number; quantity: number}>): void {
  engine.start();
  for (const i of items) engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: i.slotId, itemId: i.itemId, quantity: i.quantity});
  vi.advanceTimersByTime(600);
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Engine.reset() — in-town', () => {
  it('zeroes session drops + mapCount, preserves bag totals, no save event', () => {
    const events: EngineEvent[] = [];
    const engine = makeEngine(events);
    boot(engine, [{slotId: 1, itemId: 100, quantity: 10}]);

    // Run a map: pick up 5 of item 100, then leave.
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 15});
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    expect(ctx(engine).session?.snapshot().drops).toEqual({100: 5});
    expect(ctx(engine).mapCount).toBe(1);
    expect(ctx(engine).bag.getTotalForItem(100)).toBe(15);

    // Now reset.
    const eventsBefore = events.length;
    engine.reset();

    // Session tracker exists, totally empty.
    expect(ctx(engine).session).not.toBeNull();
    expect(ctx(engine).session?.snapshot().drops).toEqual({});
    expect(ctx(engine).mapCount).toBe(0);
    expect(ctx(engine).accumulatedMapTime).toBe(0);

    // Bag preserved.
    expect(ctx(engine).bag.getTotalForItem(100)).toBe(15);

    // Reset emits: tracker_started(session), session_status. No tracker_finished
    // for the session — that would flip the renderer's phase to 'idle' and
    // show the initializing placeholder. Map/seasonal aren't active here, so
    // no tracker_finished fires at all in this scenario.
    const newEvents = events.slice(eventsBefore);
    expect(newEvents.filter(e => e.type === 'tracker_finished')).toHaveLength(0);
    expect(newEvents.filter(e => e.type === 'tracker_started')).toHaveLength(1);
    // Fresh session_status with elapsed 0.
    const status = newEvents.find(e => e.type === 'session_status') as Extract<EngineEvent, {type: 'session_status'}>;
    expect(status?.status).toBe('running');
    expect(status?.elapsed).toBe(0);
  });
});

describe('Engine.reset() — in-map', () => {
  it('current map becomes map #1 of the new run with elapsed=0', () => {
    const events: EngineEvent[] = [];
    const engine = makeEngine(events);
    boot(engine, [{slotId: 1, itemId: 100, quantity: 10}]);

    // Enter and farm in a map across two map cycles, end up inside map #3.
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 12});
    expect(ctx(engine).mapCount).toBe(3);
    expect(ctx(engine).inMap).toBe(true);
    expect(ctx(engine).map?.snapshot().drops).toEqual({100: 2});

    const eventsBefore = events.length;
    engine.reset();

    // We were in a map → mapCount becomes 1, fresh map tracker exists.
    expect(ctx(engine).mapCount).toBe(1);
    expect(ctx(engine).inMap).toBe(true);
    expect(ctx(engine).map).not.toBeNull();
    expect(ctx(engine).map?.snapshot().drops).toEqual({});

    // Reset emits: finished(map), started(session), map_started, started(map), session_status.
    // No finished(session) on purpose — see in-town test.
    const newEvents = events.slice(eventsBefore);
    expect(newEvents.filter(e => e.type === 'tracker_finished')).toHaveLength(1); // map only
    expect(newEvents.filter(e => e.type === 'tracker_started')).toHaveLength(2);
    const mapStarted = newEvents.find(e => e.type === 'map_started') as Extract<EngineEvent, {type: 'map_started'}>;
    expect(mapStarted?.mapCount).toBe(1);
  });
});

describe('Engine.reset() — paused', () => {
  it('preserves the paused state', () => {
    const events: EngineEvent[] = [];
    const engine = makeEngine(events);
    boot(engine, [{slotId: 1, itemId: 100, quantity: 5}]);

    engine.pause();
    expect(ctx(engine).paused).toBe(true);

    engine.reset();

    expect(ctx(engine).paused).toBe(true);
    expect(ctx(engine).session?.active).toBe(false); // tracker is paused
    const status = events.filter(e => e.type === 'session_status').pop() as Extract<EngineEvent, {type: 'session_status'}>;
    expect(status.status).toBe('paused');
  });
});

describe('Engine.reset() — no-op when not tracking', () => {
  it('does nothing if engine is in idle phase', () => {
    const events: EngineEvent[] = [];
    const engine = makeEngine(events);
    // No start() — phase stays 'idle'.

    const eventsBefore = events.length;
    engine.reset();
    expect(events.length).toBe(eventsBefore);
  });
});
