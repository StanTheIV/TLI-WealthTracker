/**
 * 4.3 adversarial: useSyncExternalStore contract, timer hygiene, clock jumps,
 * visibilitychange edge cases and property checks for the display math.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

const T0 = 1_700_000_000_100;
const TICK_MS = 250;

type Clock = typeof import('@/state/clock');

async function load(): Promise<Clock> {
  vi.resetModules();
  return import('@/state/clock');
}

function stubDocument(state: 'visible' | 'hidden' = 'visible') {
  const handlers: Array<() => void> = [];
  const doc = {
    visibilityState:  state,
    addEventListener: (type: string, h: () => void) => { if (type === 'visibilitychange') handlers.push(h); },
    set:              (s: 'visible' | 'hidden') => { doc.visibilityState = s; handlers.forEach(h => h()); },
  };
  vi.stubGlobal('document', doc);
  return doc;
}

/** Deterministic PRNG so property cases are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
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

describe('getSnapshot contract', () => {
  it('returns the identical number on repeated calls while running', async () => {
    const clock = await load();
    clock.subscribe(() => undefined);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(37);
      const a = clock.getSnapshot();
      expect(clock.getSnapshot()).toBe(a);
      expect(clock.getSnapshot()).toBe(a);
    }
  });

  it('returns the identical number on repeated calls while stopped, across long gaps', async () => {
    const clock = await load();
    for (const gap of [0, 1, 249, 250, 251, 5_000, 3_600_000]) {
      vi.setSystemTime(Date.now() + gap);
      const a = clock.getSnapshot();
      expect(clock.getSnapshot()).toBe(a);
      expect(clock.getSnapshot()).toBe(a);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('while stopped never goes backwards and lags wall time by less than a tick', async () => {
    const clock = await load();
    const rand = rng(7);
    let prev = clock.getSnapshot();
    for (let i = 0; i < 500; i++) {
      vi.setSystemTime(Date.now() + Math.floor(rand() * 600));
      const s = clock.getSnapshot();
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(Date.now() - s).toBeLessThan(TICK_MS);
      prev = s;
    }
  });
});

describe('subscriber reentrancy', () => {
  it('a subscribe from inside a notification gets the next tick, not the current one, with one timer', async () => {
    const clock = await load();
    const late = vi.fn();
    let added = false;
    clock.subscribe(() => {
      if (!added) { added = true; clock.subscribe(late); }
    });
    vi.advanceTimersByTime(150);
    expect(late).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TICK_MS);
    expect(late).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('unsubscribing everything and resubscribing inside a notification leaves exactly one timer', async () => {
    const clock = await load();
    const unsubs: Array<() => void> = [];
    let again = true;
    unsubs.push(clock.subscribe(() => {
      if (!again) return;
      again = false;
      unsubs.forEach(u => u());
      clock.subscribe(() => undefined);
    }));
    vi.advanceTimersByTime(150);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TICK_MS * 4);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('timer hygiene under churn', () => {
  it('thousands of subscribe/unsubscribe cycles never leave more than one timer, and none at the end', async () => {
    const clock = await load();
    const rand = rng(42);
    const live: Array<() => void> = [];
    for (let i = 0; i < 5_000; i++) {
      if (live.length === 0 || rand() < 0.5) live.push(clock.subscribe(() => undefined));
      else live.splice(Math.floor(rand() * live.length), 1)[0]();
      expect(vi.getTimerCount()).toBe(live.length > 0 ? 1 : 0);
      if (i % 97 === 0) vi.advanceTimersByTime(Math.floor(rand() * 400));
    }
    live.forEach(u => u());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a repeated unsubscribe is harmless and does not stop the clock for other subscribers', async () => {
    const clock = await load();
    const u = clock.subscribe(() => undefined);
    clock.subscribe(() => undefined);
    u(); u(); u();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('wall clock jumping backward', () => {
  it('keeps scheduling within (0, 250] ms and never a negative or huge delay', async () => {
    const clock = await load();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    clock.subscribe(() => undefined);
    for (const jump of [-1, -37, -249, -250, -5_000, -3_600_000, 12_345]) {
      vi.setSystemTime(Date.now() + jump);
      vi.advanceTimersByTime(TICK_MS);
      vi.advanceTimersByTime(TICK_MS);
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(timeout.mock.calls.length).toBeGreaterThan(5);
    for (const call of timeout.mock.calls) {
      const d = call[1] as number;
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(TICK_MS);
    }
  });

  it('a running clock follows the wall clock back after the next tick', async () => {
    const clock = await load();
    clock.subscribe(() => undefined);
    vi.setSystemTime(Date.now() - 60_000);
    vi.advanceTimersByTime(TICK_MS);
    expect(Math.abs(Date.now() - clock.getSnapshot())).toBeLessThan(TICK_MS);
  });
});

describe('visibilitychange edge cases', () => {
  it('hidden never refreshes, with or without subscribers', async () => {
    const doc = stubDocument();
    const clock = await load();
    const cb = vi.fn();
    doc.set('hidden');
    clock.subscribe(cb);
    doc.set('hidden');
    expect(cb).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('visible with no subscribers starts no timer even after others left', async () => {
    const doc = stubDocument();
    const clock = await load();
    clock.subscribe(() => undefined)();
    doc.set('visible');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('visible with subscribers refreshes once immediately and leaves exactly one timer, repeatedly', async () => {
    const doc = stubDocument();
    const clock = await load();
    const cb = vi.fn();
    clock.subscribe(cb);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(10);
      doc.set('visible');
      expect(vi.getTimerCount()).toBe(1);
    }
    expect(cb).toHaveBeenCalledTimes(10);
    expect(clock.getSnapshot()).toBe(Date.now());
  });
});

describe('elapsedAt / countdownSec properties', () => {
  it('elapsed is monotonic non-decreasing over increasing now while running', async () => {
    const {elapsedAt} = await load();
    const rand = rng(1);
    for (let c = 0; c < 200; c++) {
      const snap = Math.floor(rand() * 1e7);
      const recv = T0 + Math.floor((rand() - 0.5) * 1e5);
      let now = T0 - 1e5;
      let prev = -Infinity;
      for (let i = 0; i < 50; i++) {
        now += Math.floor(rand() * 5_000);
        const e = elapsedAt(snap, recv, now, true);
        expect(e).toBeGreaterThanOrEqual(prev);
        expect(e).toBeGreaterThanOrEqual(snap);
        prev = e;
      }
    }
  });

  it('countdown is non-increasing as now grows, never 0, and null exactly when remaining <= 0', async () => {
    const {countdownSec} = await load();
    const rand = rng(2);
    for (let c = 0; c < 200; c++) {
      const deadline = T0 + Math.floor(rand() * 20_000);
      let now = T0 - 5_000;
      let prev = Infinity;
      for (let i = 0; i < 80; i++) {
        now += Math.floor(rand() * 600);
        const v = countdownSec(deadline, now);
        expect(v === null).toBe(deadline - now <= 0);
        if (v !== null) {
          expect(v).toBeGreaterThanOrEqual(1);
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeLessThanOrEqual(prev);
          prev = v;
        } else {
          prev = 0;
        }
      }
    }
  });

  it('pins NaN / Infinity inputs', async () => {
    const {elapsedAt, countdownSec} = await load();
    // NaN comparisons are false, so NaN propagates (no deadline-reached null).
    expect(countdownSec(NaN, T0)).toBeNaN();
    expect(countdownSec(T0, NaN)).toBeNaN();
    expect(countdownSec(Infinity, T0)).toBe(Infinity);
    expect(countdownSec(-Infinity, T0)).toBeNull();
    // Math.max(0, NaN) is NaN.
    expect(elapsedAt(5, T0, NaN, true)).toBeNaN();
    expect(elapsedAt(5, NaN, T0, true)).toBeNaN();
    expect(elapsedAt(5, T0, NaN, false)).toBe(5);
    expect(elapsedAt(5, T0, Infinity, true)).toBe(Infinity);
    expect(elapsedAt(5, T0, -Infinity, true)).toBe(5);
  });
});
