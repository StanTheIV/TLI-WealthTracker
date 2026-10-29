/**
 * 5.1c — every handler call is isolated by the Engine: a throw is logged,
 * reported as an `error` event with a `source`, and the next handler still runs.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';

const h = vi.hoisted(() => ({error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}));
vi.mock('@/main/logger', () => ({log: h}));

import {Engine} from '@/main/engine/engine';
import {BagInitHandler} from '@/main/engine/handlers/bag-init';
import {MapMaterialHandler} from '@/main/engine/handlers/map-material';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import {describeError, describeErrorBrief} from '@/shared/describe-error';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {Settings} from '@/shared/settings';
import type {EventHandler} from '@/main/engine/types';
import {TEST_IDENTITY, ctx} from './seasonal-fixtures';
import {errorsOf, stub, thrower} from './isolation-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

const SECOND = {sessionId: 'second', name: 'Second'};

function rig(...handlers: EventHandler[]) {
  const events: EngineEvent[] = [];
  const engine = new Engine(e => events.push(e));
  for (const handler of handlers) engine.register(handler);
  return {engine, events};
}

const loggedEngineError = (needle: string) =>
  h.error.mock.calls.some(([feature, msg]) => feature === 'engine' && typeof msg === 'string' && msg.includes(needle));

/** Open a session through the real bag-init handler. */
function openSession(engine: Engine): void {
  engine.start(TEST_IDENTITY);
  engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 1});
  vi.advanceTimersByTime(600);
}

describe('handle', () => {
  it('a throwing handler does not stop the next one on the same route; one error event with source; logged', () => {
    const err = new Error('boom-handle');
    const seen: string[] = [];
    const {engine, events} = rig(
      stub('A', ['reader_ready'], {handle: thrower(err)}),
      stub('B', ['reader_ready'], {handle: () => { seen.push('B'); }}),
    );
    engine.start(TEST_IDENTITY);

    expect(() => engine.onRawEvent({type: 'reader_ready'})).not.toThrow();

    expect(seen).toEqual(['B']);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toEqual({handler: 'A', hook: 'handle', rawType: 'reader_ready'});
    expect(errors[0].message).toBe(describeErrorBrief(err));
    expect(errors[0].message).not.toContain('\n');
    expect(loggedEngineError(describeError(err))).toBe(true);
  });

  it('a handler that throws a non-Error is described, not coerced', () => {
    const {engine, events} = rig(stub('A', ['reader_ready'], {handle: thrower(Object.create(null))}));
    engine.start(TEST_IDENTITY);
    expect(() => engine.onRawEvent({type: 'reader_ready'})).not.toThrow();
    expect(errorsOf(events)).toHaveLength(1);
  });
});

describe('onStart / onStop', () => {
  it('a throwing onStart is isolated; later onStart hooks still run; start() does not throw', () => {
    const err = new Error('boom-start');
    const seen: string[] = [];
    const {engine, events} = rig(
      stub('A', [], {onStart: thrower(err)}),
      stub('B', [], {onStart: () => { seen.push('B'); }}),
    );
    expect(() => engine.start(TEST_IDENTITY)).not.toThrow();
    expect(seen).toEqual(['B']);
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'A', hook: 'onStart'}]);
    expect(loggedEngineError(describeError(err))).toBe(true);
  });

  it('a throwing onStop is isolated: later onStop runs, ctx is reset, engine_stopped is emitted once and last', () => {
    const seen: string[] = [];
    const {engine, events} = rig(
      new BagInitHandler(),
      stub('A', [], {onStop: thrower(new Error('boom-stop'))}),
      stub('B', [], {onStop: () => { seen.push('B'); }}),
    );
    openSession(engine);
    events.length = 0;

    expect(() => engine.stop()).not.toThrow();

    expect(seen).toEqual(['B']);
    expect(ctx(engine).phase).toBe('idle');
    expect(ctx(engine).registry.session).toBeNull();
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'A', hook: 'onStop'}]);
    expect(events.filter(e => e.type === 'engine_stopped')).toHaveLength(1);
    expect(events[events.length - 1].type).toBe('engine_stopped');
  });
});

describe('stop() always reaches ctx.reset() and engine_stopped', () => {
  // Injection: a sink that throws on the SESSION tracker_finished (stop's own emission).
  it('a sink throwing on the session tracker_finished', () => {
    const events: EngineEvent[] = [];
    const engine = new Engine((e) => {
      if (e.type === 'tracker_finished' && e.tracker.kind === 'session') throw new Error('sink-down');
      events.push(e);
    }).register(new BagInitHandler());
    openSession(engine);
    events.length = 0;

    expect(() => engine.stop()).not.toThrow();

    expect(ctx(engine).phase).toBe('idle');
    expect(events[events.length - 1].type).toBe('engine_stopped');
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'engine', hook: 'stop'}]);
  });

  // Injection: spy on registry.promoteMapChildren (stop's first step) to throw.
  it('a throwing promoteMapChildren still emits the session tracker_finished, resets and stops', () => {
    const {engine, events} = rig(new BagInitHandler());
    openSession(engine);
    vi.spyOn(ctx(engine).registry, 'promoteMapChildren').mockImplementation(thrower(new Error('promote-boom')));
    events.length = 0;

    expect(() => engine.stop()).not.toThrow();

    expect(events.some(e => e.type === 'tracker_finished' && e.tracker.kind === 'session')).toBe(true);
    expect(ctx(engine).phase).toBe('idle');
    expect(events[events.length - 1].type).toBe('engine_stopped');
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'engine', hook: 'stop'}]);
  });
});

describe('session-open hooks', () => {
  /** A throws on its n-th open only when `armed.on`; B records. */
  function sessionRig() {
    const armed = {on: true};
    const opened: string[] = [];
    const r = rig(
      new BagInitHandler(),
      stub('A', [], {onSessionOpen: () => { if (armed.on) throw new Error('boom-open'); }}),
      stub('B', [], {onSessionOpen: () => { opened.push('B'); }}),
    );
    return {...r, opened, armed};
  }
  const sessionStarts = (events: EngineEvent[]) =>
    events.filter(e => e.type === 'tracker_started' && e.tracker.kind === 'session');

  it('via bag-init: later hooks run, the session still opens, error source names the hook', () => {
    const {engine, events, opened} = sessionRig();
    engine.start(TEST_IDENTITY);
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 1});

    expect(() => vi.advanceTimersByTime(600)).not.toThrow();

    expect(opened).toEqual(['B']);
    expect(sessionStarts(events)).toHaveLength(1);
    expect(engine.isTracking()).toBe(true);
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'A', hook: 'onSessionOpen'}]);
  });

  it('via Engine.reset: later hooks run, the new session opens', () => {
    const {engine, events, opened, armed} = sessionRig();
    armed.on = false;
    openSession(engine);
    armed.on = true;
    events.length = 0;
    opened.length = 0;

    expect(() => engine.reset(SECOND)).not.toThrow();

    expect(opened).toEqual(['B']);
    expect(sessionStarts(events)).toHaveLength(1);
    expect(ctx(engine).activeSessionId).toBe('second');
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'A', hook: 'onSessionOpen'}]);
  });
});

describe('replay', () => {
  const marker = {type: 'loot_window_ended', seasonalType: 'overrealm', timestamp: 1} as const;

  it("a throwing replay drops only that handler's events; getState still returns the rest and does not throw", () => {
    const {engine, events} = rig(
      stub('A', [], {replay: thrower(new Error('boom-replay'))}),
      stub('B', [], {replay: () => [marker]}),
    );
    engine.start(TEST_IDENTITY);

    let state: EngineEvent[] = [];
    expect(() => { state = engine.getState(); }).not.toThrow();

    expect(state).toContainEqual({type: 'init_started'});
    expect(state).toContainEqual(marker);
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'A', hook: 'replay'}]);
  });
});

describe('configure / dismissMaterial', () => {
  it('a throwing configure is isolated and the next handler still configures', () => {
    const seen: string[] = [];
    const {engine, events} = rig(
      stub('A', [], {configure: thrower(new Error('boom-configure'))}),
      stub('B', [], {configure: () => { seen.push('B'); }}),
    );
    expect(() => engine.configure({} as Settings)).not.toThrow();
    expect(seen).toEqual(['B']);
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'A', hook: 'configure'}]);
  });

  // Injection: spy on MapMaterialHandler.dismiss (the handler the Engine addresses directly).
  it('a throwing dismissMaterial is isolated with hook dismissMaterial', () => {
    const mm = new MapMaterialHandler();
    vi.spyOn(mm, 'dismiss').mockImplementation(thrower(new Error('boom-dismiss')));
    const {engine, events} = rig(mm);
    expect(() => engine.dismissMaterial(1)).not.toThrow();
    expect(errorsOf(events).map(e => e.source)).toEqual([{handler: 'map-material', hook: 'dismissMaterial'}]);
  });
});

describe('the error emit itself', () => {
  it('a sink that throws on the error event does not recurse or throw out; later handlers run', () => {
    let errorDeliveries = 0;
    const seen: string[] = [];
    const engine = new Engine((e) => {
      if (e.type === 'error') { errorDeliveries++; throw new Error('sink-rejects-error'); }
    })
      .register(stub('A', ['reader_ready'], {handle: thrower(new Error('boom'))}))
      .register(stub('B', ['reader_ready'], {handle: () => { seen.push('B'); }}));
    engine.start(TEST_IDENTITY);

    expect(() => engine.onRawEvent({type: 'reader_ready'})).not.toThrow();

    expect(errorDeliveries).toBe(1);
    expect(seen).toEqual(['B']);
  });
});

describe('ErrorHandler is gone', () => {
  it('createEngine registers no handler named "error" and routes nothing for reader_error', () => {
    const events: EngineEvent[] = [];
    const engine = createProductionEngine(e => events.push(e));
    expect(engine.getHandler('error')).toBeNull();
    expect((engine as unknown as {_routes: Map<string, unknown>})._routes.has('reader_error')).toBe(false);

    engine.start(TEST_IDENTITY);
    events.length = 0;
    engine.onRawEvent({type: 'reader_error', message: 'File not found'});
    expect(events).toEqual([]);
  });
});
