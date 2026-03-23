import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Engine} from '@/main/engine/engine';
import {BagInitHandler} from '@/main/engine/handlers/bag-init';
import {ZoneHandler} from '@/main/engine/handlers/zone';
import {ItemHandler} from '@/main/engine/handlers/item';
import {ErrorHandler} from '@/main/engine/handlers/error';
import type {EngineEvent} from '@/main/engine/types';

function createEngine(events: EngineEvent[]): Engine {
  return new Engine((e) => events.push(e))
    .register(new BagInitHandler())
    .register(new ZoneHandler())
    .register(new ItemHandler())
    .register(new ErrorHandler());
}

describe('Engine (integration)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('full session: init → map → drops → town', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    engine.start();
    expect(events.find(e => e.type === 'init_started')).toBeDefined();

    // Bag initialisation
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 10});
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 2, itemId: 200, quantity: 5});
    vi.advanceTimersByTime(600);

    expect(events.find(e => e.type === 'init_complete')).toBeDefined();

    // Enter map
    engine.onRawEvent({type: 'zone_transition', fromScene: 'XZ_YuJinZhiXiBiNanSuo200', toScene: '/Game/Art/Maps/S5_Boss'});
    expect(events.find(e => e.type === 'map_started')).toBeDefined();

    // Pick up items in map (immediate flush)
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 15}); // +5
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 8});  // +3
    const drops = events.filter(e => e.type === 'drop');
    expect(drops).toHaveLength(2);

    // Leave map
    engine.onRawEvent({type: 'zone_transition', fromScene: '/Game/Art/Maps/S5_Boss', toScene: 'XZ_YuJinZhiXiBiNanSuo200'});
    expect(events.find(e => e.type === 'map_ended')).toBeDefined();
  });

  it('routes reader_error to ErrorHandler', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    engine.start();

    engine.onRawEvent({type: 'reader_error', message: 'File not found'});

    const err = events.find(e => e.type === 'error');
    expect(err).toMatchObject({type: 'error', message: 'File not found'});
  });

  it('ignores unregistered event types', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    engine.start();

    // reader_ready is not handled — should not throw
    expect(() => engine.onRawEvent({type: 'reader_ready'})).not.toThrow();
  });

  it('stop clears all state and timers', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    engine.start();

    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1});
    engine.stop();
    vi.advanceTimersByTime(1000);

    // No init_complete should fire after stop
    expect(events.find(e => e.type === 'init_complete')).toBeUndefined();
  });

  it('can restart after stop', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    engine.start();
    engine.stop();

    events.length = 0;
    engine.start();
    expect(events.find(e => e.type === 'init_started')).toBeDefined();
  });
});
