/** A throwing clock listener never stops the tick — timer and visibilitychange paths. */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

/** Not on a 250 ms boundary: the next one is T0 + 150. */
const T0 = 1_700_000_000_100;
const TICK_MS = 250;

type Clock = typeof import('@/state/clock');

async function load(): Promise<Clock> {
  vi.resetModules();
  return import('@/state/clock');
}

function stubDocument() {
  const handlers: Array<() => void> = [];
  const doc = {
    visibilityState:  'visible' as 'visible' | 'hidden',
    addEventListener: (type: string, h: () => void) => { if (type === 'visibilitychange') handlers.push(h); },
    set:              (s: 'visible' | 'hidden') => { doc.visibilityState = s; handlers.forEach(h => h()); },
  };
  vi.stubGlobal('document', doc);
  return doc;
}

/** A subscriber that records the snapshot it sees on every notification. */
function recorder(clock: Clock) {
  const seen: number[] = [];
  const unsubscribe = clock.subscribe(() => seen.push(clock.getSnapshot()));
  return {seen, unsubscribe};
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({now: T0});
  vi.unstubAllGlobals();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a throwing listener on the timer path', () => {
  it('does not escape the tick, and a timer stays armed while subscribers exist', async () => {
    const clock = await load();
    const good = vi.fn();
    let boom = true;
    clock.subscribe(() => { if (boom) { boom = false; throw new Error('x'); } });
    clock.subscribe(good);
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TICK_MS);
    expect(good).toHaveBeenCalled();
  });

  it('the listeners before and after it still receive that tick', async () => {
    const clock = await load();
    const before = recorder(clock);
    clock.subscribe(() => { throw new Error('x'); });
    const after = recorder(clock);
    vi.advanceTimersByTime(150);
    expect(before.seen).toEqual([T0 + 150]);
    expect(after.seen).toEqual([T0 + 150]);
  });

  it('the next tick still fires on the boundary and notifies everyone, the thrower included', async () => {
    const clock = await load();
    let boom = true;
    const thrower = vi.fn(() => { if (boom) { boom = false; throw new Error('x'); } });
    clock.subscribe(thrower);
    const other = recorder(clock);
    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(TICK_MS);
    expect(thrower).toHaveBeenCalledTimes(2);
    expect(other.seen).toEqual([T0 + 150, T0 + 150 + TICK_MS]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('reports the error once per throw, and only for the throwing listener', async () => {
    const clock = await load();
    const err = new Error('boom');
    clock.subscribe(() => { throw err; });
    clock.subscribe(() => undefined);
    vi.advanceTimersByTime(150);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenLastCalledWith(expect.any(String), err);
    vi.advanceTimersByTime(TICK_MS * 2);
    expect(consoleError).toHaveBeenCalledTimes(3);
  });

  it('a listener that drops the last subscription and then throws still stops the clock', async () => {
    const clock = await load();
    const unsubscribe = clock.subscribe(() => { unsubscribe(); throw new Error('x'); });
    vi.advanceTimersByTime(150);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe('a throwing listener on the visibilitychange path', () => {
  it('does not escape, the others are notified, the error is reported once and the tick keeps its boundary', async () => {
    const doc = stubDocument();
    const clock = await load();
    const err = new Error('boom');
    let boom = true;
    const before = recorder(clock);
    clock.subscribe(() => { if (boom) { boom = false; throw err; } });
    const after = recorder(clock);

    vi.advanceTimersByTime(60);
    expect(() => doc.set('visible')).not.toThrow();
    expect(before.seen).toEqual([T0 + 60]);
    expect(after.seen).toEqual([T0 + 60]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenLastCalledWith(expect.any(String), err);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(90);
    expect(before.seen).toEqual([T0 + 60, T0 + 150]);
    expect(after.seen).toEqual([T0 + 60, T0 + 150]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
