/**
 * LootCollectionTimer — a frozen (session-paused) window ignores refresh() and
 * reset(): it keeps its remaining time and resumes from it on unfreeze().
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {LootCollectionTimer} from '@/main/engine/loot-collection-timer';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function frozenAfter(elapsedMs: number) {
  const onExpire = vi.fn();
  const timer    = new LootCollectionTimer(5_000, onExpire);
  timer.start();
  vi.advanceTimersByTime(elapsedMs);
  timer.freeze();
  return {timer, onExpire};
}

describe('LootCollectionTimer while frozen', () => {
  it('refresh() is a no-op: returns false, stays frozen, never fires', () => {
    const {timer, onExpire} = frozenAfter(3_000); // 2s left < 80% step — would re-arm if live

    expect(timer.refresh()).toBe(false);
    expect(timer.frozen).toBe(true);
    expect(timer.active).toBe(true);
    expect(timer.deadline).toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('reset() is a no-op: stays frozen, never fires', () => {
    const {timer, onExpire} = frozenAfter(3_000);

    timer.reset();
    expect(timer.frozen).toBe(true);
    expect(timer.deadline).toBeNull();

    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('unfreeze() after an ignored refresh/reset resumes the remaining window, not a fresh one', () => {
    const {timer, onExpire} = frozenAfter(3_000);
    timer.refresh();
    timer.reset();

    expect(timer.unfreeze()).toBe(true);
    vi.advanceTimersByTime(1_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(timer.active).toBe(false);
  });

  it('a live timer still refreshes and resets', () => {
    const onExpire = vi.fn();
    const timer    = new LootCollectionTimer(5_000, onExpire);
    timer.start();
    vi.advanceTimersByTime(3_000);
    expect(timer.refresh()).toBe(true); // re-armed to 4s
    vi.advanceTimersByTime(3_999);
    expect(onExpire).not.toHaveBeenCalled();
    timer.reset();                      // full 5s again
    vi.advanceTimersByTime(4_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
