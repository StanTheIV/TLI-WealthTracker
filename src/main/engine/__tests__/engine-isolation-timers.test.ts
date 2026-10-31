/** 5.1c — a throw inside an engine timer callback is isolated, not an uncaught exception. */
import {describe, it, expect, vi, beforeEach} from 'vitest';

const h = vi.hoisted(() => ({error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}));
vi.mock('@/main/logger', () => ({log: h}));

import type {EngineEvent} from '@/shared/contracts/engine';
import {boot, createDispatcher, createEngine, createEngineWithEmit, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';
import {errorsOf, thrower} from './isolation-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

describe('bag-init debounce apply', () => {
  // Injection: spy on ctx.bag.init (called first by _initialize), once.
  it('a throw is isolated (handler bag-init, hook timer); the next dump still opens the session', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    const init = vi.spyOn(ctx(e).bag, 'init').mockImplementationOnce(thrower(new Error('init-boom')));

    e.start({sessionId: 's', name: 'S'});
    feed(d, e, log.bagInit(1, 300, 5));
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();

    expect(errorsOf(events).map(x => x.source)).toEqual([{handler: 'bag-init', hook: 'timer'}]);
    expect(h.error.mock.calls.some(([f, m]) => f === 'engine' && String(m).includes('init-boom'))).toBe(true);
    // State left behind: the failed dump is gone (cleared before the apply), phase is still
    // 'initializing' — so a fresh dump opens the session normally.
    expect(ctx(e).phase).toBe('initializing');
    expect(events.some(x => x.type === 'tracker_started' && x.tracker.kind === 'session')).toBe(false);

    init.mockRestore();
    feed(d, e, log.bagInit(1, 300, 5));
    vi.advanceTimersByTime(600);
    expect(ctx(e).phase).toBe('tracking');
    expect(events.some(x => x.type === 'tracker_started' && x.tracker.kind === 'session')).toBe(true);
  });
});

describe('item buffer flush', () => {
  // Injection: the sink throws on the town flush's first-seen `new_item` (emit is what _flush calls).
  it('a throw in the town flush timer is isolated (handler item, hook timer)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngineWithEmit((ev) => {
      if (ev.type === 'new_item' && ev.itemId === 999) throw new Error('flush-boom');
      events.push(ev);
    });
    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.bagUpdate(2, 999, 5)); // town: buffered, 1500 ms timer

    expect(() => vi.advanceTimersByTime(1_600)).not.toThrow();

    expect(errorsOf(events).map(x => x.source)).toEqual([{handler: 'item', hook: 'timer'}]);
  });
});

describe('loot-window expiry', () => {
  // Injection: spy on the seasonal tracker's finish(), which _onLootExpire calls.
  it('a throw on expiry is isolated (handler registry, hook lootExpire)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);
    const tracker = ctx(e).registry.seasonal('overrealm')!;
    vi.spyOn(tracker, 'finish').mockImplementation(thrower(new Error('expire-boom')));

    expect(() => vi.advanceTimersByTime(5_100)).not.toThrow();

    expect(errorsOf(events).map(x => x.source)).toEqual([{handler: 'registry', hook: 'lootExpire'}]);
  });
});
