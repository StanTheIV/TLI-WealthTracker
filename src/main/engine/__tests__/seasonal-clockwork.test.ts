/**
 * Clockwork Ballet (S7) — HandleS7PushData + fail-page UI.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Clockwork integration', () => {
  it('s7_start alone does NOT create a seasonal tracker — drops during the game go to session/map only', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.s7Start);
    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'clockwork')).toBe(false);

    feed(d, e, log.bagUpdate(1, 700, 4));
    expect(ctx(e).session?.snapshot().drops[700]).toBe(4);
    expect(ctx(e).map?.snapshot().drops[700]).toBe(4);
    expect(ctx(e).seasonals.size).toBe(0);
  });

  it('s7_success (voucher turn-in) starts tracker + loot timer', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Start);
    feed(d, e, log.s7Success);

    expect(ctx(e).seasonals.get('clockwork')).toBeDefined();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'clockwork')).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);

    vi.advanceTimersByTime(5_100);

    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'clockwork')).toBe(true);
  });

  it('s7_fail also starts tracker + loot timer', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Start);
    feed(d, e, log.s7Fail);

    expect(ctx(e).seasonals.get('clockwork')).toBeDefined();

    vi.advanceTimersByTime(5_100);

    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'clockwork')).toBe(true);
  });

  it('drops after the turn-in are attributed to clockwork', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Start);
    feed(d, e, log.s7Success);

    feed(d, e, log.bagUpdate(1, 700, 7));
    expect(ctx(e).seasonals.get('clockwork')?.snapshot().drops[700]).toBe(7);
    expect(ctx(e).session?.snapshot().drops[700]).toBe(7);
    expect(ctx(e).map?.snapshot().drops[700]).toBe(7);
  });

  it('entering town during loot window cancels timer and finishes immediately', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Start);
    feed(d, e, log.s7Success);

    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'clockwork')).toBe(true);

    // No double-finish after the original timer would have expired.
    events.length = 0;
    vi.advanceTimersByTime(5_100);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('duplicate s7_success is ignored while the loot timer is active', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Success);
    feed(d, e, log.s7Success); // duplicate

    const starts = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'clockwork');
    expect(starts).toHaveLength(1);
  });
});
