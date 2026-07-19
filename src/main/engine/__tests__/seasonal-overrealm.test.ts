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

    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'overrealm')).toBe(true);
  });

  it('repeated s12_entry events do not duplicate the tracker (idempotent)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Entry);

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

    expect(overrealm(e).isLootCollecting()).toBe(true);
    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();
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
    expect(ctx(e).registry.seasonal('overrealm')?.snapshot().drops[300]).toBe(7);
  });

  it('loot timer expires and finishes overrealm tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();

    // Advance past the 5-second loot window
    vi.advanceTimersByTime(5_100);

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'overrealm')).toBe(true);
  });

  it('bag_update during loot window refreshes timer (decaying 80%-of-current rule)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    // Advance to 4.5s (remaining=0.5s < 0.8 * 5000 = 4s → refresh re-arms to 4s)
    vi.advanceTimersByTime(4_500);
    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();

    feed(d, e, log.bagUpdate(1, 300, 2)); // triggers refresh → timer reset to 4s

    // 3.9s later — still within the refreshed 4s window
    vi.advanceTimersByTime(3_900);
    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();

    // Let it expire (0.1s + buffer)
    vi.advanceTimersByTime(200);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });

  it('entering town during loot window cancels timer and finishes tracker immediately', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);

    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();

    // Enter town — should cancel timer and finish immediately
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
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

    // Player walks into another Overrealm portal in the same map while their
    // loot window is still ticking — handler cancels the timer and keeps the
    // existing tracker.
    feed(d, e, log.s12Entry);

    expect(overrealm(e).isLootCollecting()).toBe(false);
    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();

    // Timer cancelled — advancing time should not finish the tracker
    vi.advanceTimersByTime(6_000);
    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();
  });

  it('death/abandon (no s12_exit) keeps the tracker alive until town entry', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    // No s12_exit — player died or abandoned. Tracker stays alive.
    expect(overrealm(e).isLootCollecting()).toBe(false);
    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();

    // Town entry finishes the tracker through ZoneHandler's centralised path.
    feed(d, e, log.zoneTransition(MAP, TOWN));
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'overrealm')).toBe(true);
  });

  it('next map after a completed Overrealm starts a fresh tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);

    // --- Map 1: full Overrealm + town entry ---
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.s12Exit);
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);

    const startedFirst = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'overrealm');
    expect(startedFirst).toHaveLength(1);

    // --- Map 2: a fresh portal must produce a brand-new tracker ---
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);

    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();
    const startedAll = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'overrealm');
    expect(startedAll).toHaveLength(2);
  });
});
