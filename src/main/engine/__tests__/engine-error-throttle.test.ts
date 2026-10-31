/** 5.1c — repeat errors per (handler, hook): first reported, then at most one per 10 s with a suppressed count. */
import {describe, it, expect, vi, beforeEach} from 'vitest';

const h = vi.hoisted(() => ({error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}));
vi.mock('@/main/logger', () => ({log: h}));

import {Engine} from '@/main/engine/engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {Settings} from '@/shared/settings';
import {TEST_IDENTITY} from './seasonal-fixtures';
import {errorsOf, stub, thrower} from './isolation-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

function rig() {
  const events: EngineEvent[] = [];
  const engine = new Engine(e => events.push(e))
    .register(stub('A', ['reader_ready'], {handle: thrower(new Error('a-handle')), configure: thrower(new Error('a-configure'))}))
    .register(stub('B', ['reader_ready'], {handle: thrower(new Error('b-handle'))}));
  engine.start(TEST_IDENTITY);
  events.length = 0;
  return {engine, events};
}
const fire = (engine: Engine) => engine.onRawEvent({type: 'reader_ready'});
const aHandle = (events: EngineEvent[]) => errorsOf(events).filter(e => e.source?.handler === 'A' && e.source.hook === 'handle');
const logged = (needle: string) =>
  h.error.mock.calls.filter(([f, m]) => f === 'engine' && String(m).includes(needle)).map(([, m]) => String(m));

describe('throttle', () => {
  it('reports the first, suppresses within 10 s, then reports with (+N suppressed) in message and log', () => {
    const {engine, events} = rig();
    fire(engine);
    vi.advanceTimersByTime(1_000);
    fire(engine);
    vi.advanceTimersByTime(8_000);
    fire(engine); // t = 9 s: still suppressed
    expect(aHandle(events)).toHaveLength(1);
    expect(aHandle(events)[0].message).not.toContain('suppressed');
    expect(logged('a-handle')).toHaveLength(1);

    vi.advanceTimersByTime(1_500); // t = 10.5 s
    fire(engine);
    const reports = aHandle(events);
    expect(reports).toHaveLength(2);
    expect(reports[1].message).toContain('(+2 suppressed)');
    expect(logged('a-handle')[1]).toContain('(+2 suppressed)');

    // the count was consumed: the next report after another window carries no suffix
    vi.advanceTimersByTime(10_500);
    fire(engine);
    expect(aHandle(events)).toHaveLength(3);
    expect(aHandle(events)[2].message).not.toContain('suppressed');
  });

  it('the 10 s window is measured from the last REPORTED error, not the last suppressed one', () => {
    const {engine, events} = rig();
    fire(engine); // t0 reported
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(3_000); fire(engine); } // t = 3, 6, 9, 12 s
    // 12 s > 10 s after the report at t0, so the t = 12 s throw is the second report
    expect(aHandle(events)).toHaveLength(2);
    expect(aHandle(events)[1].message).toContain('(+3 suppressed)');
  });

  it('different handlers and different hooks throttle independently', () => {
    const {engine, events} = rig();
    fire(engine);
    engine.configure({} as Settings);
    const sources = errorsOf(events).map(e => `${e.source?.handler}:${e.source?.hook}`);
    expect(sources.sort()).toEqual(['A:configure', 'A:handle', 'B:handle']);

    fire(engine);
    engine.configure({} as Settings);
    expect(errorsOf(events)).toHaveLength(3); // all suppressed
  });

  it('start() clears the throttle', () => {
    const {engine, events} = rig();
    fire(engine);
    fire(engine); // suppressed
    expect(aHandle(events)).toHaveLength(1);

    engine.start(TEST_IDENTITY);
    fire(engine);
    const reports = aHandle(events);
    expect(reports).toHaveLength(2);
    expect(reports[1].message).not.toContain('suppressed');
  });
});
