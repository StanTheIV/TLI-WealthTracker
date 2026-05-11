/**
 * Carjack (S11) — music play/stop triggers with loot collection timer.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Carjack integration', () => {
  it('s11_start starts carjack tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);

    expect(ctx(e).registry.seasonal('carjack')).toBeDefined();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'carjack')).toBe(true);
  });

  it('duplicate s11_start does not restart the tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11Start); // duplicate — should be ignored

    const started = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'carjack');
    expect(started).toHaveLength(1);
  });

  it('s11_end starts loot timer, tracker stays alive', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11End);

    expect(ctx(e).registry.seasonal('carjack')).toBeDefined(); // still alive during loot window
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('loot timer expires and finishes carjack tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11End);

    expect(ctx(e).registry.seasonal('carjack')).toBeDefined();

    vi.advanceTimersByTime(5_100);

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'carjack')).toBe(true);
  });

  it('bag_update during loot window refreshes timer (decaying 80%-of-current rule)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11End);

    // Advance to 4.5s (remaining=0.5s < 0.8 * 5000 = 4s → refresh re-arms to 4s)
    vi.advanceTimersByTime(4_500);
    expect(ctx(e).registry.seasonal('carjack')).toBeDefined();

    feed(d, e, log.bagUpdate(1, 400, 2)); // triggers refresh

    // 3.9s later — still within the refreshed 4s window
    vi.advanceTimersByTime(3_900);
    expect(ctx(e).registry.seasonal('carjack')).toBeDefined();

    // Let it expire
    vi.advanceTimersByTime(200);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });

  it('entering town during loot window cancels timer and finishes tracker immediately', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11End);

    expect(ctx(e).registry.seasonal('carjack')).toBeDefined();

    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'carjack')).toBe(true);

    // Timer should be gone — no double-finish after original timeout
    events.length = 0;
    vi.advanceTimersByTime(5_100);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('drops during carjack reach session, map and carjack trackers', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);

    feed(d, e, log.bagUpdate(1, 400, 6));

    expect(ctx(e).registry.session?.snapshot().drops[400]).toBe(6);
    expect(ctx(e).registry.map?.snapshot().drops[400]).toBe(6);
    expect(ctx(e).registry.seasonal('carjack')?.snapshot().drops[400]).toBe(6);
  });

  it('drops during loot window are attributed to carjack tracker', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11End);

    feed(d, e, log.bagUpdate(1, 400, 3));
    expect(ctx(e).registry.seasonal('carjack')?.snapshot().drops[400]).toBe(3);
  });
});
