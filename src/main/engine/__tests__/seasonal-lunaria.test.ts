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

    expect(ctx(e).registry.seasonal('lunaria')).toBeDefined();
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'lunaria')).toBe(true);
    expect(events.some(ev => ev.type === 'loot_window_started' && ev.seasonalType === 'lunaria')).toBe(true);
  });

  it('drops after first strum credit lunaria AND the map — lunaria is in-map', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);
    feed(d, e, log.bagUpdate(1, 1400, 4));

    expect(ctx(e).registry.seasonal('lunaria')?.snapshot().drops[1400]).toBe(4);
    expect(ctx(e).registry.map?.snapshot().drops[1400]).toBe(4); // drops through
    expect(ctx(e).registry.session?.snapshot().drops[1400]).toBe(4);
    // Breakdown still credits lunaria alone, so slices sum to session FE.
    expect(ctx(e).registry.session?.snapshot().dropsBySource!.lunaria?.[1400]).toBe(4);
    expect(ctx(e).registry.session?.snapshot().dropsBySource!.map?.[1400]).toBeUndefined();
  });

  it('a strum does NOT pause the map — lunaria is an in-map mechanic', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
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
    expect(ctx(e).registry.seasonal('lunaria')).toBeDefined();
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(false);
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

    expect(ctx(e).registry.seasonal('lunaria')?.snapshot().drops[1400]).toBe(3);
    // The map never paused, so it accrued both: the +3 dropped through while
    // lunaria owned it, and the +4 after lunaria went dormant.
    expect(ctx(e).registry.map?.snapshot().drops[1400]).toBe(7);
    expect(ctx(e).registry.session?.snapshot().drops[1400]).toBe(7);
    // Ownership moved to the map when lunaria self-paused.
    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.lunaria?.[1400]).toBe(3);
    expect(dbs.map?.[1400]).toBe(4);
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

    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(false);

    feed(d, e, log.s14Strum); // resume + re-arm
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    feed(d, e, log.bagUpdate(1, 1400, 5)); // +3 (within new loot window)
    expect(ctx(e).registry.seasonal('lunaria')?.snapshot().drops[1400]).toBe(5); // 2 + 3
  });

  it('mid-window strum unconditionally resets the timer to the full window', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // Advance to 4.5s elapsed — would expire in 0.5s without intervention.
    vi.advanceTimersByTime(4_500);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    feed(d, e, log.s14Strum); // strum resets to full 5s window

    // 4.9s into the fresh 5s window — still active (was 4.5s + 4.9s = 9.4s
    // total, well past the original 5s deadline).
    vi.advanceTimersByTime(4_900);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    // 0.2s more — fresh window expires.
    vi.advanceTimersByTime(200);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(false);
  });

  it('bag_update during the loot window refreshes the timer (decaying rule)', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // Advance to 4.5s — remaining 0.5s < 80% of current (4s).
    vi.advanceTimersByTime(4_500);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    // Pickup during the loot window — re-arms to 80% of current = 4000ms.
    feed(d, e, log.bagUpdate(1, 1400, 5));

    vi.advanceTimersByTime(3_900);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    vi.advanceTimersByTime(200);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(false);
  });

  it('strum early in the window still resets — pushes deadline out past the original', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // 500ms into the 5s window — strum unconditionally resets to a fresh 5s.
    vi.advanceTimersByTime(500);
    feed(d, e, log.s14Strum);

    // 4.6s after the strum (t=5100, past the original 5s deadline) — still
    // alive because the strum reset moved the deadline to t=5500.
    vi.advanceTimersByTime(4_600);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    // Original would have expired at t=5000; reset window expires at t=5500.
    vi.advanceTimersByTime(500);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(false);
  });

  it('consecutive pickups decay the loot window (5s → 4s → 3.2s)', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // Advance to 4.5s — first pickup re-arms to 4000ms.
    vi.advanceTimersByTime(4_500);
    feed(d, e, log.bagUpdate(1, 1400, 1));
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    // Advance to 3.5s into the new 4000ms window — remaining = 500 < 0.8 *
    // 4000 = 3200, so the second pickup re-arms to 3200ms.
    vi.advanceTimersByTime(3_500);
    feed(d, e, log.bagUpdate(1, 1400, 2));
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    // 3.1s in — still alive (window is 3200ms now).
    vi.advanceTimersByTime(3_100);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    // 0.2s more — the decayed 3200ms window expires.
    vi.advanceTimersByTime(200);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(false);
  });

  it('decaying pickup-refresh floors at 1000ms — pickups inside the floored window keep extending it', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // Walk down through the geometric decay until we hit the 1000ms floor.
    // Each pickup fires when remaining < 0.8 * current — advance to the very
    // tail of each window so the next pickup actually re-arms.
    // 5000 → 4000 (advance 4500, remaining 500 < 4000)
    vi.advanceTimersByTime(4_500);
    feed(d, e, log.bagUpdate(1, 1400, 1));
    // 4000 → 3200 (advance 3500, remaining 500 < 3200)
    vi.advanceTimersByTime(3_500);
    feed(d, e, log.bagUpdate(1, 1400, 2));
    // 3200 → 2560 (advance 2700, remaining 500 < 2560)
    vi.advanceTimersByTime(2_700);
    feed(d, e, log.bagUpdate(1, 1400, 3));
    // 2560 → 2048 (advance 2060, remaining 500 < 2048)
    vi.advanceTimersByTime(2_060);
    feed(d, e, log.bagUpdate(1, 1400, 4));
    // 2048 → 1638 (advance 1548, remaining 500 < 1638)
    vi.advanceTimersByTime(1_548);
    feed(d, e, log.bagUpdate(1, 1400, 5));
    // 1638 → 1310 (advance 1138, remaining 500 < 1310)
    vi.advanceTimersByTime(1_138);
    feed(d, e, log.bagUpdate(1, 1400, 6));
    // 1310 → 1048 (advance 810, remaining 500 < 1048)
    vi.advanceTimersByTime(810);
    feed(d, e, log.bagUpdate(1, 1400, 7));
    // 1048 → floor=1000 (advance 548, remaining 500 < 1000)
    vi.advanceTimersByTime(548);
    feed(d, e, log.bagUpdate(1, 1400, 8));
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    // At the floor. A pickup inside the 1000ms window re-arms back to a
    // fresh 1000ms — a steady stream of pickups can extend the floored
    // window indefinitely. Verify by chaining three pickups separated by
    // 800ms each: total elapsed at the floor = 800 * 3 = 2400ms, which is
    // well past one floored window, but the timer must still be active.
    vi.advanceTimersByTime(800);
    feed(d, e, log.bagUpdate(1, 1400, 9));
    vi.advanceTimersByTime(800);
    feed(d, e, log.bagUpdate(1, 1400, 10));
    vi.advanceTimersByTime(800);
    feed(d, e, log.bagUpdate(1, 1400, 11));
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    // Stop picking up — the next floored 1000ms window runs out without a
    // refresh and the tracker pauses.
    vi.advanceTimersByTime(1_100);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(false);
  });

  it('strum after pickup-decay restores the full window', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);

    // First pickup decays the window to 4000ms.
    vi.advanceTimersByTime(4_500);
    feed(d, e, log.bagUpdate(1, 1400, 1));

    // Second pickup decays it again to 3200ms.
    vi.advanceTimersByTime(3_500);
    feed(d, e, log.bagUpdate(1, 1400, 2));

    // Strum now — fresh 5000ms window, undoing the decay.
    feed(d, e, log.s14Strum);

    // 4.9s after the strum — still active (would have already expired under
    // the decayed 3200ms window).
    vi.advanceTimersByTime(4_900);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(true);

    vi.advanceTimersByTime(200);
    expect(ctx(e).registry.seasonal('lunaria')?.active).toBe(false);
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

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
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

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(ctx(e).registry.map).toBeNull();
  });
});
