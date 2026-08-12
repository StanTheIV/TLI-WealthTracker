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

  it('drops during carjack credit carjack AND the map — carjack is in-map', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);

    feed(d, e, log.bagUpdate(1, 400, 6));

    expect(ctx(e).registry.session?.snapshot().drops[400]).toBe(6);
    expect(ctx(e).registry.map?.snapshot().drops[400]).toBe(6); // drops through (in-map)
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

  it('an abandoned encounter closes on idle instead of waiting for the Stop marker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11Wave);

    // Player walks away. The real Stop marker trailed the last mob by 24s in the
    // measured encounter; the tracker must not own the map's drops until then.
    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonal('carjack')?.active).toBe(false);

    feed(d, e, log.bagUpdate(1, 400, 9)); // unrelated map loot
    expect(ctx(e).registry.seasonal('carjack')?.snapshot().drops[400]).toBeUndefined();
  });

  it('a mid-combat lull parks the tracker and the next kill resumes the same run', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);

    // A real encounter contained a 7.89s gap with genuine kills on both sides.
    vi.advanceTimersByTime(7_890);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);

    feed(d, e, log.s11Wave);
    expect(ctx(e).registry.seasonal('carjack')?.active).toBe(true);
    expect(events.filter(ev => ev.type === 'tracker_started'
      && ev.tracker.seasonalType === 'carjack')).toHaveLength(1);

    // That final kill's loot must still credit Carjack.
    feed(d, e, log.bagUpdate(1, 400, 4));
    expect(ctx(e).registry.seasonal('carjack')?.snapshot().drops[400]).toBe(4);
  });

  it('the terminal despawn burst does not count as activity', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);

    vi.advanceTimersByTime(4_000);
    feed(d, e, log.s11Despawn); // Mon_DisAppear — fires as the encounter ends
    vi.advanceTimersByTime(1_100);

    expect(ctx(e).registry.seasonal('carjack')?.active).toBe(false);
  });

  it('pickups do not extend combat, only the post-encounter window', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);

    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(2_000);
      feed(d, e, log.bagUpdate(1, 400, i));
    }
    expect(ctx(e).registry.seasonal('carjack')?.active).toBe(false);
  });

  it('a late second Stop marker is a no-op', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11End);

    vi.advanceTimersByTime(5_100); // terminal window closes the run
    expect(ctx(e).registry.seasonalsSize()).toBe(0);

    // The bare Stop form arrives 6-34s after the combined one.
    feed(d, e, log.s11End);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.filter(ev => ev.type === 'tracker_started'
      && ev.tracker.seasonalType === 'carjack')).toHaveLength(1);
  });
});
