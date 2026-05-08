/**
 * Lunaria (S14) — strum-driven seasonal that pauses between episodes.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Lunaria integration', () => {
  it('first s14_strum starts the lunaria tracker AND arms the loot timer', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    expect(ctx(e).seasonals.get('lunaria')).toBeDefined();
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'lunaria')).toBe(true);
    expect(events.some(ev => ev.type === 'loot_window_started' && ev.seasonalType === 'lunaria')).toBe(true);
  });

  it('drops after first strum (within loot window) attribute to lunaria', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);
    feed(d, e, log.bagUpdate(1, 1400, 4));

    expect(ctx(e).seasonals.get('lunaria')?.snapshot().drops[1400]).toBe(4);
    expect(ctx(e).map?.snapshot().drops[1400]).toBe(4);
    expect(ctx(e).session?.snapshot().drops[1400]).toBe(4);
  });

  it('loot timer expiry pauses the tracker (does NOT finish it)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    vi.advanceTimersByTime(5_100);

    // Tracker still in ctx.seasonals — just paused.
    expect(ctx(e).seasonals.get('lunaria')).toBeDefined();
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'lunaria')).toBe(false);
    expect(events.some(ev => ev.type === 'loot_window_ended' && ev.seasonalType === 'lunaria')).toBe(true);
  });

  it('drops while paused do NOT attribute to lunaria (tracker.addDrop short-circuits)', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);
    feed(d, e, log.bagUpdate(1, 1400, 3)); // attributes (active)
    vi.advanceTimersByTime(5_100); // pause

    feed(d, e, log.bagUpdate(1, 1400, 7)); // +4 while paused — must NOT count for lunaria

    expect(ctx(e).seasonals.get('lunaria')?.snapshot().drops[1400]).toBe(3);
    // session/map still see the drop
    expect(ctx(e).map?.snapshot().drops[1400]).toBe(7);
    expect(ctx(e).session?.snapshot().drops[1400]).toBe(7);
  });

  it('next s14_strum resumes the paused tracker AND re-arms the loot timer', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);
    feed(d, e, log.bagUpdate(1, 1400, 2));
    vi.advanceTimersByTime(5_100); // pause

    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(false);

    feed(d, e, log.s14Strum); // resume + re-arm
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(true);

    feed(d, e, log.bagUpdate(1, 1400, 5)); // +3 (within new loot window)
    expect(ctx(e).seasonals.get('lunaria')?.snapshot().drops[1400]).toBe(5); // 2 + 3
  });

  it('mid-window strum refreshes the timer when remaining is below 80% threshold', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // Advance to 4.5s elapsed → remaining = 0.5s, which is below the 80%
    // threshold (4s of the 5s window). Next refresh re-arms to 4s.
    vi.advanceTimersByTime(4_500);
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(true);

    feed(d, e, log.s14Strum); // strum triggers refresh

    // 3.9s into the refreshed 4s window — would have expired without refresh.
    vi.advanceTimersByTime(3_900);
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(true);

    // 0.2s more — refreshed window expires.
    vi.advanceTimersByTime(200);
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(false);
  });

  it('bag_update during the loot window refreshes the timer (same 80% rule)', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // Advance to 4.5s — remaining 0.5s < 80% threshold.
    vi.advanceTimersByTime(4_500);
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(true);

    // Pickup during the loot window — same refresh path as Overrealm/Carjack.
    feed(d, e, log.bagUpdate(1, 1400, 5));

    vi.advanceTimersByTime(3_900);
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(true);

    vi.advanceTimersByTime(200);
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(false);
  });

  it('strum early in the window does NOT re-arm (above 80% threshold)', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // Advance only 500ms — remaining 4.5s is well above the 80% threshold
    // (4s). Refresh is a no-op; original 5s timer keeps ticking.
    vi.advanceTimersByTime(500);
    feed(d, e, log.s14Strum); // refresh attempted but ignored

    // 4.5s more from t=500 — total 5s = original deadline → expires.
    vi.advanceTimersByTime(4_600);
    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(false);
  });

  it('town entry finishes the (paused) lunaria tracker via ZoneHandler', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);
    vi.advanceTimersByTime(5_100); // pause

    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'lunaria')).toBe(true);
  });

  it('multiple episodes accumulate into one lunaria tracker', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Episode 1
    feed(d, e, log.s14Strum);
    feed(d, e, log.bagUpdate(1, 1400, 3));
    vi.advanceTimersByTime(5_100); // pause

    // Walk between clusters: a drop here must NOT count for lunaria.
    feed(d, e, log.bagUpdate(1, 1400, 4)); // +1 while paused

    // Episode 2
    feed(d, e, log.s14Strum); // resume
    feed(d, e, log.bagUpdate(1, 1400, 9)); // +5
    vi.advanceTimersByTime(5_100); // pause

    // Final town entry — ZoneHandler finishes the tracker
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).seasonals.size).toBe(0);
    expect(ctx(e).map).toBeNull();
  });
});
