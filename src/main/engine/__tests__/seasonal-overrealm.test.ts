/**
 * Overrealm (S12) — entry / exit / loot collection timer.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, overrealm, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Overrealm integration', () => {
  it('s12_entry starts overrealm tracker on first stage', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);

    expect(ctx(e).seasonals.get('overrealm')).toBeDefined();
    expect(overrealm(e).isInOverrealm()).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'overrealm')).toBe(true);
  });

  it('subsequent s12_entry events (stage 2/3) do not restart the tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry); // stage 1
    feed(d, e, log.s12Entry); // stage 2 — should be ignored

    const started = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'overrealm');
    expect(started).toHaveLength(1);
  });

  it('s12_exit arms the loot collection timer; tracker stays alive', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    expect(overrealm(e).isInOverrealm()).toBe(false);
    expect(overrealm(e).isLootCollecting()).toBe(true);
    expect(ctx(e).seasonals.get('overrealm')).toBeDefined();
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('drops during loot window are attributed to overrealm tracker', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    // Still in loot window — bag update should reach overrealm tracker
    feed(d, e, log.bagUpdate(1, 300, 7));
    expect(ctx(e).seasonals.get('overrealm')?.snapshot().drops[300]).toBe(7);
  });

  it('loot timer expires and finishes overrealm tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    expect(ctx(e).seasonals.get('overrealm')).toBeDefined();

    // Advance past the 5-second loot window
    vi.advanceTimersByTime(5_100);

    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'overrealm')).toBe(true);
  });

  it('bag_update during loot window refreshes timer when below 80% threshold', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    // Advance to 4.5s (remaining=0.5s < 80% threshold=4s → refresh resets to 4s)
    vi.advanceTimersByTime(4_500);
    expect(ctx(e).seasonals.get('overrealm')).toBeDefined();

    feed(d, e, log.bagUpdate(1, 300, 2)); // triggers refresh → timer reset to 4s

    // 3.9s later — still within the refreshed 4s window
    vi.advanceTimersByTime(3_900);
    expect(ctx(e).seasonals.get('overrealm')).toBeDefined();

    // Let it expire (0.1s + buffer)
    vi.advanceTimersByTime(200);
    expect(ctx(e).seasonals.size).toBe(0);
  });

  it('entering town during loot window cancels timer and finishes tracker immediately', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    expect(ctx(e).seasonals.get('overrealm')).toBeDefined();

    // Enter town — should cancel timer and finish immediately
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'overrealm')).toBe(true);

    // Timer should be gone — no double-finish after original timeout
    events.length = 0;
    vi.advanceTimersByTime(5_100);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('re-entering Overrealm during loot window cancels timer and resumes session', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    // Re-enter before timer expires (player took another Overrealm portal in
    // the same map).
    feed(d, e, log.s12Entry);

    expect(overrealm(e).isInOverrealm()).toBe(true);
    expect(overrealm(e).isLootCollecting()).toBe(false);
    expect(ctx(e).seasonals.get('overrealm')).toBeDefined();

    // Timer cancelled — advancing time should not finish the tracker
    vi.advanceTimersByTime(6_000);
    expect(ctx(e).seasonals.get('overrealm')).toBeDefined();
  });

  it('s12_exit while NOT in Overrealm is ignored (defensive)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Spurious s12_exit with no preceding s12_entry — engine is fresh, no
    // tracker, no loot window. Must be a no-op.
    feed(d, e, log.s12Exit);

    expect(ctx(e).seasonals.size).toBe(0);
    expect(overrealm(e).isLootCollecting()).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'overrealm')).toBe(false);
  });
});
