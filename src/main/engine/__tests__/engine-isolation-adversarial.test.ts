/** 5.1c adversarial: nested isolation, throttle edges, start/reset throttle lifetime, hostile sinks, timers around stop/reset. */
import {describe, it, expect, vi, beforeEach} from 'vitest';

const h = vi.hoisted(() => ({error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}));
vi.mock('@/main/logger', () => ({log: h}));

import {Engine} from '@/main/engine/engine';
import {BagInitHandler} from '@/main/engine/handlers/bag-init';
import {ItemHandler} from '@/main/engine/handlers/item';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {EventHandler} from '@/main/engine/types';
import {TEST_IDENTITY} from './seasonal-fixtures';
import {errorsOf, stub, thrower} from './isolation-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.clearAllMocks();
});

function rig(...handlers: EventHandler[]) {
  const events: EngineEvent[] = [];
  const engine = new Engine(e => events.push(e));
  for (const handler of handlers) engine.register(handler);
  return {engine, events};
}
const bag = (engine: Engine) => {
  engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 1});
  vi.advanceTimersByTime(600);
};

describe('nested isolation', () => {
  it('a session-open hook throwing inside a bag_snapshot_start handle: reported once as the hook, never also as bag-init:handle', () => {
    const { engine, events } = rig(
      new BagInitHandler(),
      stub('A', [], {onSessionOpen: thrower(new Error('hook boom'))}),
    );
    engine.start(TEST_IDENTITY);
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 1});
    expect(() => engine.onRawEvent({type: 'bag_snapshot_start'})).not.toThrow();
    expect(engine.isTracking()).toBe(true);
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'A', hook: 'onSessionOpen'}]);
  });

  it('a hook throwing inside a handle that ALSO throws afterwards yields two distinct reports', () => {
    const inner = stub('A', [], {onSessionOpen: thrower(new Error('inner'))});
    const bagInit = new BagInitHandler();
    const realHandle = bagInit.handle.bind(bagInit);
    bagInit.handle = (...a) => { realHandle(...a); throw new Error('outer'); };
    const { engine, events } = rig(bagInit, inner);
    engine.start(TEST_IDENTITY);
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 1});
    engine.onRawEvent({type: 'bag_snapshot_start'});
    expect(errorsOf(events).map(e => `${e.source?.handler}:${e.source?.hook}`).sort())
      .toEqual(['A:onSessionOpen', 'bag-init:handle']);
    expect(engine.isTracking()).toBe(true);
  });

  it('a handler that re-enters the engine (onRawEvent from inside handle) with a throwing sibling does not corrupt reporting', () => {
    const seen: string[] = [];
    const { engine, events } = rig(
      stub('Outer', ['reader_ready'], {handle: () => { engine.onRawEvent({type: 'reader_error', message: 'x'}); seen.push('outer'); }}),
      stub('Inner', ['reader_error'], {handle: thrower(new Error('inner boom'))}),
      stub('Tail', ['reader_ready'], {handle: () => { seen.push('tail'); }}),
    );
    engine.start(TEST_IDENTITY);
    expect(() => engine.onRawEvent({type: 'reader_ready'})).not.toThrow();
    expect(seen).toEqual(['outer', 'tail']);
    expect(errorsOf(events).map(e => e.source?.handler)).toEqual(['Inner']);
  });

  it('a throw in a session-open hook during the debounce TIMER is reported via ctx.isolate with the bag-init timer source or the hook source, not escaping into the timer', () => {
    const { engine, events } = rig(new BagInitHandler(), stub('A', [], {onSessionOpen: thrower(new Error('hook boom'))}));
    engine.start(TEST_IDENTITY);
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 1});
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    expect(errorsOf(events)).toHaveLength(1);
    expect(engine.isTracking()).toBe(true);
  });
});

describe('throttle edges', () => {
  function throwingRig() {
    const r = rig(stub('A', ['reader_ready'], {handle: thrower(new Error('a'))}));
    r.engine.start(TEST_IDENTITY);
    r.events.length = 0;
    return r;
  }
  const fire = (e: Engine) => e.onRawEvent({type: 'reader_ready'});

  it('9 999 ms after a report is suppressed; exactly 10 000 ms reports', () => {
    const { engine, events } = throwingRig();
    fire(engine);
    vi.advanceTimersByTime(9_999);
    fire(engine);
    expect(errorsOf(events)).toHaveLength(1);
    vi.advanceTimersByTime(1);          // now exactly 10 000 after the first report
    fire(engine);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(2);
    expect(errors[1].message).toContain('(+1 suppressed)');
  });

  it('the count carries exactly the number of suppressed repeats, then resets to zero', () => {
    const { engine, events } = throwingRig();
    fire(engine);
    for (let i = 0; i < 25; i++) fire(engine);
    vi.advanceTimersByTime(10_000);
    fire(engine);
    vi.advanceTimersByTime(10_000);
    fire(engine);
    const msgs = errorsOf(events).map(e => e.message);
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toContain('(+25 suppressed)');
    expect(msgs[2]).not.toContain('suppressed');
  });

  it('the same (handler, hook) for different raw event types shares one throttle bucket', () => {
    const { engine, events } = rig(stub('A', ['reader_ready', 'reader_error'], {handle: thrower(new Error('a'))}));
    engine.start(TEST_IDENTITY);
    events.length = 0;
    engine.onRawEvent({type: 'reader_ready'});
    engine.onRawEvent({type: 'reader_error', message: 'm'});
    expect(errorsOf(events)).toHaveLength(1);
  });

  it('start() clears the throttle (and counts), reset() keeps it', () => {
    const { engine, events } = rig(new BagInitHandler(), stub('A', ['reader_ready'], {handle: thrower(new Error('a'))}));
    engine.start(TEST_IDENTITY);
    bag(engine);
    events.length = 0;
    fire(engine);
    engine.reset({sessionId: 's2', name: 'S2'});
    fire(engine);
    expect(errorsOf(events)).toHaveLength(1);

    engine.stop();
    engine.start({sessionId: 's3', name: 'S3'});
    fire(engine);
    expect(errorsOf(events)).toHaveLength(2);
    expect(errorsOf(events)[1].message).not.toContain('suppressed');
  });

  it('stop() without start() keeps the throttle: an error right after stop is still suppressed', () => {
    const { engine, events } = throwingRig();
    fire(engine);
    engine.stop();
    // a lingering handler call after stop: phase idle but routes still fire
    fire(engine);
    expect(errorsOf(events)).toHaveLength(1);
  });

  it('a long throw storm (50 000 events) emits one error per 10 s window and bounded log lines', () => {
    const { engine, events } = throwingRig();
    for (let i = 0; i < 50_000; i++) {
      fire(engine);
      if (i % 1000 === 999) vi.advanceTimersByTime(1_000);   // 50 s total
    }
    expect(errorsOf(events).length).toBeLessThanOrEqual(6);
    expect(h.error.mock.calls.filter(c => c[0] === 'engine').length).toBeLessThanOrEqual(6);
  });
});

describe('hostile sinks', () => {
  it('a sink that throws on EVERYTHING: start, raw events and the session opening do not throw out of the engine', () => {
    const engine = new Engine(() => { throw new Error('sink dead'); })
      .register(new BagInitHandler())
      .register(stub('A', ['reader_ready'], {handle: thrower(new Error('a'))}));
    expect(() => engine.start(TEST_IDENTITY)).not.toThrow();
    expect(() => engine.onRawEvent({type: 'reader_ready'})).not.toThrow();
    expect(() => engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1})).not.toThrow();
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    expect(h.error.mock.calls.some(c => String(c[1]).includes('not delivered'))).toBe(true);
  });

  it('a sink throwing a non-Error (Symbol, null-prototype object) on the error event is still contained', () => {
    for (const thrown of [Symbol('x'), Object.create(null), null, undefined, 1n]) {
      const engine = new Engine(e => { if (e.type === 'error') throw thrown; })
        .register(stub('A', ['reader_ready'], {handle: thrower(new Error('a'))}));
      engine.start(TEST_IDENTITY);
      expect(() => engine.onRawEvent({type: 'reader_ready'})).not.toThrow();
    }
  });

  it('a handler throwing hostile values (Symbol, getter-throwing object, huge string) is contained and the message stays one short line', () => {
    const hostile = [
      Symbol('s'),
      { get message() { throw new Error('getter'); }, get stack() { throw new Error('getter'); } },
      'x'.repeat(1_000_000),
      Object.create(null),
      new Proxy({}, { get() { throw new Error('proxy trap'); } }),
    ];
    for (const thrown of hostile) {
      const { engine, events } = rig(stub('A', ['reader_ready'], {handle: thrower(thrown)}));
      engine.start(TEST_IDENTITY);
      expect(() => engine.onRawEvent({type: 'reader_ready'})).not.toThrow();
      const [err] = errorsOf(events);
      expect(err).toBeDefined();
      expect(err.message).not.toContain('\n');
      expect(err.message.length).toBeLessThan(10_000);
    }
  });
});

describe('getState', () => {
  it('a throwing replay reports once; a second getState within 10 s is silent but still omits that handler', () => {
    const marker = {type: 'loot_window_ended', seasonalType: 'overrealm', timestamp: 1} as const;
    const { engine, events } = rig(
      stub('A', [], {replay: thrower(new Error('replay boom'))}),
      stub('B', [], {replay: () => [marker]}),
    );
    engine.start(TEST_IDENTITY);
    events.length = 0;
    const s1 = engine.getState();
    const s2 = engine.getState();
    expect(errorsOf(events)).toHaveLength(1);
    expect(s1).toEqual(s2);
    expect(s1).toContainEqual(marker);
    expect(s1.some(e => e.type === 'error')).toBe(false);
  });

  it('an idle engine reports no error and does not run replay hooks', () => {
    const replay = vi.fn(() => []);
    const { engine, events } = rig(stub('A', [], {replay}));
    expect(engine.getState()).toEqual([]);
    expect(replay).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe('timers around stop() and reset()', () => {
  it('a pending bag-init debounce is discarded by stop(): no session, no events, no error afterwards', () => {
    const { engine, events } = rig(new BagInitHandler());
    engine.start(TEST_IDENTITY);
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1});
    engine.stop();
    events.length = 0;
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(events).toEqual([]);
    expect(engine.isTracking()).toBe(false);
  });

  it('a pending item-flush timer never emits after engine_stopped', () => {
    const { engine, events } = rig(new BagInitHandler(), new ItemHandler());
    engine.start(TEST_IDENTITY);
    bag(engine);
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 5} as never);
    engine.stop();
    const n = events.length;
    vi.advanceTimersByTime(60_000);
    expect(events.length).toBe(n);
    expect(events[events.length - 1].type).toBe('engine_stopped');
  });

  it('a resort debounce pending during reset() fires without throwing and without errors', () => {
    const engine = createProductionEngine(() => undefined);
    const events: EngineEvent[] = [];
    const e2 = createProductionEngine(ev => events.push(ev));
    void engine;
    e2.start(TEST_IDENTITY);
    bag(e2);
    e2.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 2});
    e2.reset({sessionId: 's2', name: 'S2'});
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(errorsOf(events)).toEqual([]);
    expect(e2.isTracking()).toBe(true);
  });

  it('start() after a stop with a throwing timer-bearing handler: timers of the previous run do not leak errors into the new run', () => {
    const { engine, events } = rig(new BagInitHandler(), stub('A', [], {onSessionOpen: thrower(new Error('boom'))}));
    engine.start(TEST_IDENTITY);
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 1});
    engine.stop();
    engine.start({sessionId: 's2', name: 'S2'});
    events.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(errorsOf(events)).toEqual([]);
  });
});

describe('stop() ordering under failures', () => {
  it('every onStop throwing still resets, and exactly one engine_stopped is the last event', () => {
    const { engine, events } = rig(
      new BagInitHandler(),
      stub('A', [], {onStop: thrower(new Error('a'))}),
      stub('B', [], {onStop: thrower(new Error('b'))}),
    );
    engine.start(TEST_IDENTITY);
    bag(engine);
    engine.stop();
    expect(events.filter(e => e.type === 'engine_stopped')).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('engine_stopped');
    expect(engine.isTracking()).toBe(false);
    expect(errorsOf(events).map(e => e.source?.handler).sort()).toEqual(['A', 'B']);
  });

  it('stop() twice and stop() on a never-started engine emit nothing the second time', () => {
    const { engine, events } = rig(new BagInitHandler());
    engine.stop();
    expect(events).toEqual([]);
    engine.start(TEST_IDENTITY);
    engine.stop();
    const n = events.length;
    engine.stop();
    expect(events.length).toBe(n);
  });
});
