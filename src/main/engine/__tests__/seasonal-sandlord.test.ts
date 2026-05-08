/**
 * Sandlord (S10) — pure zone-transition trigger, whole bubble in one tracker.
 *
 * Also includes the load-bearing `hasActiveMapTracker()` discriminator tests:
 * the IPC layer reads that flag at the moment a seasonal tracker_finished
 * arrives to decide whether to write a standalone session_maps row (Sandlord)
 * or fold the seasonal's drops into the upcoming map row (Vorex/Dream/etc.).
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {Engine}            from '@/main/engine/engine';
import type {EngineEvent}  from '@/main/engine/types';
import {
  boot, createDispatcher, createEngine, createEngineWithEmit, ctx, feed, log,
  MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TOWN,
} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Sandlord integration', () => {
  it('town → hub starts a sandlord seasonal tracker and no map tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 800, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));

    expect(ctx(e).seasonals.get('sandlord')).toBeDefined();
    expect(ctx(e).seasonals.get('sandlord')?.ownsBubble).toBe(true);
    expect(ctx(e).inMap).toBe(false);
    expect(ctx(e).map).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'sandlord')).toBe(true);
    expect(events.some(ev => ev.type === 'map_started')).toBe(false);
  });

  it('hub → sub-map keeps the bubble open, no map tracker is created', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 800, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    events.length = 0;

    feed(d, e, log.zoneTransition(SANDLORD_HUB, SANDLORD_SUB_MAP));

    expect(ctx(e).seasonals.get('sandlord')).toBeDefined();
    expect(ctx(e).inMap).toBe(false);
    expect(ctx(e).map).toBeNull();
    expect(events.some(ev => ev.type === 'map_started')).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'sandlord')).toBe(false);
  });

  it('drops inside hub and sub-map are attributed to the single sandlord tracker', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 800, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    feed(d, e, log.bagUpdate(1, 800, 3));   // delta +3
    feed(d, e, log.zoneTransition(SANDLORD_HUB, SANDLORD_SUB_MAP));
    feed(d, e, log.bagUpdate(1, 800, 10));  // delta +7
    vi.advanceTimersByTime(2_000);          // flush ItemHandler town-debounce

    expect(ctx(e).seasonals.get('sandlord')?.snapshot().drops[800]).toBe(10);
    expect(ctx(e).map).toBeNull();
  });

  it('returning to town finishes the sandlord tracker and clears the bubble flag', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 800, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    feed(d, e, log.zoneTransition(SANDLORD_HUB, SANDLORD_SUB_MAP));
    feed(d, e, log.zoneTransition(SANDLORD_SUB_MAP, SANDLORD_HUB));
    events.length = 0;

    feed(d, e, log.zoneTransition(SANDLORD_HUB, TOWN));

    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'sandlord')).toBe(true);
    expect(events.some(ev => ev.type === 'map_ended')).toBe(false);
  });

  it('after sandlord ends, normal map tracking resumes on next map entry', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 800, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    feed(d, e, log.zoneTransition(SANDLORD_HUB, TOWN));
    events.length = 0;

    feed(d, e, log.zoneTransition(TOWN, MAP));

    expect(ctx(e).inMap).toBe(true);
    expect(ctx(e).map).not.toBeNull();
    expect(events.some(ev => ev.type === 'map_started')).toBe(true);
  });

  it('repeated sandlord runs each get their own tracker and do not double-start', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 800, quantity: 0}]);

    // First run
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    feed(d, e, log.zoneTransition(SANDLORD_HUB, SANDLORD_SUB_MAP));
    feed(d, e, log.zoneTransition(SANDLORD_SUB_MAP, SANDLORD_HUB));
    feed(d, e, log.zoneTransition(SANDLORD_HUB, TOWN));

    // Second run
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    feed(d, e, log.zoneTransition(SANDLORD_HUB, TOWN));

    const starts   = events.filter(ev => ev.type === 'tracker_started'  && ev.tracker.seasonalType === 'sandlord');
    const finishes = events.filter(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'sandlord');
    expect(starts).toHaveLength(2);
    expect(finishes).toHaveLength(2);
  });

  it('sub-map → hub does not duplicate tracker_started', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 800, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    feed(d, e, log.zoneTransition(SANDLORD_HUB, SANDLORD_SUB_MAP));
    feed(d, e, log.zoneTransition(SANDLORD_SUB_MAP, SANDLORD_HUB));

    const starts = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'sandlord');
    expect(starts).toHaveLength(1);
  });

  // The IPC layer uses engine.hasActiveMapTracker() at the moment a seasonal
  // tracker_finished arrives to discriminate "Sandlord-style standalone run"
  // (write a session_maps row) from "Vorex/Dream/etc. inside a map" (skip,
  // because the upcoming map row already covers it). These two tests pin
  // that discriminator's behaviour.

  it('hasActiveMapTracker is false when sandlord seasonal finishes', () => {
    let activeMapAtSeasonalFinish: boolean | null = null;
    const events: EngineEvent[] = [];
    let engine: Engine;
    const captureEmit = (ev: EngineEvent) => {
      events.push(ev);
      if (ev.type === 'tracker_finished' && ev.tracker.kind === 'seasonal') {
        activeMapAtSeasonalFinish = engine.hasActiveMapTracker();
      }
    };
    engine = createEngineWithEmit(captureEmit);
    const d = createDispatcher();

    boot(d, engine, [{slotId: 1, itemId: 800, quantity: 0}]);
    feed(d, engine, log.zoneTransition(TOWN, SANDLORD_HUB));
    feed(d, engine, log.zoneTransition(SANDLORD_HUB, TOWN));

    expect(activeMapAtSeasonalFinish).toBe(false);
  });

  it('hasActiveMapTracker is true when in-map seasonal (vorex) finishes via town entry', () => {
    let activeMapAtSeasonalFinish: boolean | null = null;
    const events: EngineEvent[] = [];
    let engine: Engine;
    const captureEmit = (ev: EngineEvent) => {
      events.push(ev);
      if (ev.type === 'tracker_finished' && ev.tracker.kind === 'seasonal') {
        activeMapAtSeasonalFinish = engine.hasActiveMapTracker();
      }
    };
    engine = createEngineWithEmit(captureEmit);
    const d = createDispatcher();

    boot(d, engine, [{slotId: 1, itemId: 800, quantity: 0}]);
    feed(d, engine, log.zoneTransition(TOWN, MAP));
    feed(d, engine, log.s13Start);
    feed(d, engine, log.zoneTransition(MAP, TOWN));

    expect(activeMapAtSeasonalFinish).toBe(true);
  });
});
