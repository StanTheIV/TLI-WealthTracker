/**
 * 4.3: the shared 4 Hz display clock (`src/state/clock.ts`) under fake timers.
 * The module keeps its cached `now`, subscribers and timer at module level, so
 * it is re-imported per test; `document` is stubbed where visibilitychange is
 * exercised (Node has none).
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TICK_MS, countdownSec, elapsedAt} from '@/state/clock';

/** Not on a 250 ms boundary: the next one is T0 + 150. */
const T0 = 1_700_000_000_100;

type Clock = typeof import('@/state/clock');

interface FakeDocument {
  visibilityState: 'visible' | 'hidden';
  addEventListener: ReturnType<typeof vi.fn>;
  /** Flip the visibility and dispatch `visibilitychange`. */
  set: (s: 'visible' | 'hidden') => void;
}

function stubDocument(): FakeDocument {
  const handlers: Array<() => void> = [];
  const doc: FakeDocument = {
    visibilityState:  'visible',
    addEventListener: vi.fn((type: string, h: () => void) => { if (type === 'visibilitychange') handlers.push(h); }),
    set:              s => { doc.visibilityState = s; handlers.forEach(h => h()); },
  };
  vi.stubGlobal('document', doc);
  return doc;
}

async function load(): Promise<Clock> {
  vi.resetModules();
  return import('@/state/clock');
}

/** A subscriber that records the snapshot it sees on every notification. */
function recorder(clock: Clock) {
  const seen: number[] = [];
  const unsubscribe = clock.subscribe(() => seen.push(clock.getSnapshot()));
  return {seen, unsubscribe};
}

beforeEach(() => {
  vi.useFakeTimers({now: T0});
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('clock ticks', () => {
  it('ticks first at the next 250 ms boundary, then every 250 ms', async () => {
    const clock = await load();
    const r = recorder(clock);

    vi.advanceTimersByTime(149);
    expect(r.seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.seen).toEqual([T0 + 150]);
    vi.advanceTimersByTime(TICK_MS * 3);
    expect(r.seen).toEqual([T0 + 150, T0 + 400, T0 + 650, T0 + 900]);
    expect(r.seen.every(t => t % TICK_MS === 0)).toBe(true);
  });

  it('re-aligns after a late tick instead of drifting', async () => {
    const clock = await load();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    let first = true;
    const seen: number[] = [];
    // The first tick's work takes 40 ms (stands in for a throttled/late tick).
    clock.subscribe(() => {
      seen.push(clock.getSnapshot());
      if (first) { first = false; vi.setSystemTime(Date.now() + 40); }
    });

    vi.advanceTimersByTime(150);
    expect(timeout).toHaveBeenLastCalledWith(expect.any(Function), TICK_MS - 40);
    vi.advanceTimersByTime(TICK_MS - 40);
    expect(seen).toEqual([T0 + 150, T0 + 400]);
  });

  it('re-aligns after the wall clock jumps (sleep)', async () => {
    const clock = await load();
    const r = recorder(clock);
    vi.setSystemTime(T0 + 60_037); // timers keep their relative due time
    vi.advanceTimersByTime(150);
    const late = r.seen[0];
    expect(late % TICK_MS).not.toBe(0);
    vi.advanceTimersByTime(TICK_MS - (late % TICK_MS));
    expect(r.seen[1] % TICK_MS).toBe(0);
    vi.advanceTimersByTime(TICK_MS);
    expect(r.seen[2] - r.seen[1]).toBe(TICK_MS);
  });

  it('runs ONE timer for N subscribers and notifies each per tick', async () => {
    const clock = await load();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const rs = [recorder(clock), recorder(clock), recorder(clock)];

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(150 + TICK_MS);
    expect(vi.getTimerCount()).toBe(1);
    expect(timeout).toHaveBeenCalledTimes(3); // initial + one re-arm per tick
    for (const r of rs) expect(r.seen).toEqual([T0 + 150, T0 + 400]);
  });

  it('stops at zero subscribers and restarts on the next', async () => {
    const clock = await load();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const a = recorder(clock);
    const b = recorder(clock);

    a.unsubscribe();
    expect(vi.getTimerCount()).toBe(1);
    b.unsubscribe();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect([...a.seen, ...b.seen]).toEqual([]);

    const c = recorder(clock);
    expect(vi.getTimerCount()).toBe(1);
    expect(clock.getSnapshot()).toBe(T0 + 10_000);
    vi.advanceTimersByTime(150); // re-aligned to the boundary, not 250 ms after the restart
    expect(c.seen).toEqual([T0 + 10_150]);
  });

  it('stops when the last subscriber leaves during a notification', async () => {
    const clock = await load();
    const unsubs: Array<() => void> = [];
    const seen: string[] = [];
    unsubs.push(clock.subscribe(() => { seen.push('a'); unsubs.forEach(u => u()); }));
    unsubs.push(clock.subscribe(() => seen.push('b')));

    vi.advanceTimersByTime(150);
    expect(seen).toEqual(['a', 'b']); // notified from a copy: b still sees this tick
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a resubscribe from inside a notification keeps a single timer', async () => {
    const clock = await load();
    let resubscribed = false;
    const unsub = clock.subscribe(() => {
      if (resubscribed) return;
      resubscribed = true;
      unsub();
      clock.subscribe(() => undefined);
    });

    vi.advanceTimersByTime(150);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('clock snapshot', () => {
  it('the first subscribe refreshes now synchronously', async () => {
    const clock = await load();
    expect(clock.getSnapshot()).toBe(T0);
    vi.setSystemTime(T0 + 100); // under one tick: the stopped clock's lazy catch-up won't fire
    clock.subscribe(() => undefined);
    expect(clock.getSnapshot()).toBe(T0 + 100);
  });

  it('is stable between ticks while running', async () => {
    const clock = await load();
    clock.subscribe(() => undefined);
    vi.advanceTimersByTime(149);
    expect(clock.getSnapshot()).toBe(T0);
    expect(clock.getSnapshot()).toBe(clock.getSnapshot());
    vi.advanceTimersByTime(1);
    expect(clock.getSnapshot()).toBe(T0 + 150);
  });

  it('while stopped catches up at most once per tick period, starting no timer', async () => {
    const clock = await load();
    vi.setSystemTime(T0 + TICK_MS - 1);
    expect(clock.getSnapshot()).toBe(T0);
    vi.setSystemTime(T0 + 5_000);
    expect(clock.getSnapshot()).toBe(T0 + 5_000);
    vi.setSystemTime(T0 + 5_100);
    expect(clock.getSnapshot()).toBe(T0 + 5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives StrictMode subscribe → unsubscribe → subscribe', async () => {
    const clock = await load();
    const seen: number[] = [];
    const cb = () => seen.push(clock.getSnapshot());

    const first = clock.subscribe(cb);
    first();
    clock.subscribe(cb);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(150);
    expect(seen).toEqual([T0 + 150]);

    first(); // a stale unsubscribe must not drop the live subscription
    vi.advanceTimersByTime(TICK_MS);
    expect(seen).toEqual([T0 + 150, T0 + 400]);
  });

  it('the same callback subscribed twice is two subscriptions', async () => {
    const clock = await load();
    const cb = vi.fn();
    const u1 = clock.subscribe(cb);
    const u2 = clock.subscribe(cb);
    vi.advanceTimersByTime(150);
    expect(cb).toHaveBeenCalledTimes(2);
    u1();
    expect(vi.getTimerCount()).toBe(1);
    u2();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('clock visibilitychange', () => {
  it('without a document (Node) the module loads and ticks', async () => {
    const clock = await load();
    expect(typeof document).toBe('undefined');
    const r = recorder(clock);
    vi.advanceTimersByTime(150);
    expect(r.seen).toEqual([T0 + 150]);
  });

  it('becoming visible refreshes, notifies and re-aligns the tick', async () => {
    const doc = stubDocument();
    const clock = await load();
    expect(doc.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    const r = recorder(clock);

    vi.advanceTimersByTime(60);
    doc.set('visible');
    expect(r.seen).toEqual([T0 + 60]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(90); // the boundary is unchanged
    expect(r.seen).toEqual([T0 + 60, T0 + 150]);
  });

  it('becoming hidden does nothing', async () => {
    const doc = stubDocument();
    const clock = await load();
    const r = recorder(clock);
    vi.advanceTimersByTime(60);
    doc.set('hidden');
    expect(r.seen).toEqual([]);
    expect(clock.getSnapshot()).toBe(T0);
  });

  it('with no subscribers starts no timer', async () => {
    const doc = stubDocument();
    await load();
    doc.set('visible');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('elapsedAt', () => {
  it('extrapolates a running tracker from when its snapshot arrived', () => {
    expect(elapsedAt(5_000, T0, T0 + 1_250, true)).toBe(6_250);
  });

  it('returns a paused tracker as is', () => {
    expect(elapsedAt(5_000, T0, T0 + 1_250, false)).toBe(5_000);
  });

  it('returns the snapshot as is without a receivedAt', () => {
    expect(elapsedAt(5_000, null, T0 + 1_250, true)).toBe(5_000);
  });

  it('clamps a snapshot that arrived after the last tick', () => {
    expect(elapsedAt(5_000, T0 + 200, T0, true)).toBe(5_000);
  });
});

describe('countdownSec', () => {
  it('is null without a deadline', () => {
    expect(countdownSec(null, T0)).toBeNull();
  });

  it('is null once the deadline has passed or is reached', () => {
    expect(countdownSec(T0 - 1, T0)).toBeNull();
    expect(countdownSec(T0, T0)).toBeNull();
  });

  it('is exact on a whole-second boundary', () => {
    expect(countdownSec(T0 + 3_000, T0)).toBe(3);
  });

  it('rounds a partial second up', () => {
    expect(countdownSec(T0 + 2_001, T0)).toBe(3);
    expect(countdownSec(T0 + 1, T0)).toBe(1);
  });
});
