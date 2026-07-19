/**
 * Vorex (S13) — window open/close/abandon.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN, VOREX_REWARD} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Vorex integration', () => {
  it('s13_start starts vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    expect(ctx(e).registry.seasonal('vorex')).toBeDefined();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('s13_window_close pauses the vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    feed(d, e, log.s13WindowClose);

    expect(ctx(e).registry.seasonal('vorex')).toBeDefined();
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(false); // paused
    expect(events.some(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('second s13_start after window_close resumes the vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13WindowClose);

    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(false);

    feed(d, e, log.s13Start); // reopen
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(true);
  });

  it('s13_abandon → zone to reward zone completes Vorex, tracker stays alive', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13Abandon);

    // Zone to reward zone = completed
    feed(d, e, log.zoneTransition(MAP, VOREX_REWARD));

    expect(ctx(e).registry.seasonal('vorex')).toBeDefined(); // still alive for loot
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false); // not finished yet
  });

  it('s13_abandon → zone to non-reward zone abandons Vorex, tracker finishes', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13Abandon);

    // Zone to some other area = abandoned
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('starting Vorex from town does NOT spawn a phantom map tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    // Player opens the Vorex window in town, then zones straight into the
    // reward zone (DiXiaZhenSuo). ZoneHandler must treat this seasonal scene
    // as 'unknown', not 'map' — no map tracker on top of Vorex.
    feed(d, e, log.s13Start);
    feed(d, e, log.zoneTransition(TOWN, VOREX_REWARD));

    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(true);
    expect(ctx(e).registry.map).toBeNull();
    expect(events.some(ev => ev.type === 'map_started')).toBe(false);
  });

  it('town -> Vorex -> town finishes the vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s13Start);
    feed(d, e, log.zoneTransition(TOWN, VOREX_REWARD));
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(true);

    // Return to town — no map tracker was ever started (inMap is false), but the
    // seasonal must still finish.
    feed(d, e, log.zoneTransition(VOREX_REWARD, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('drops in a town-started Vorex reach session and vorex, but no map', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s13Start);
    feed(d, e, log.zoneTransition(TOWN, VOREX_REWARD));

    feed(d, e, log.bagUpdate(1, 200, 4));

    expect(ctx(e).registry.session?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.seasonal('vorex')?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.map).toBeNull();
  });

  it('opening the vorex window on a map pauses the map; closing it resumes it', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000);

    feed(d, e, log.s13Start); // window opens — map freezes
    expect(ctx(e).registry.map?.active).toBe(false);
    vi.advanceTimersByTime(20_000);

    feed(d, e, log.s13WindowClose); // closed — map resumes, vorex pauses
    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(ctx(e).registry.map?.elapsed()).toBe(15_000); // window time excluded
  });

  it('map-started commit: minigame + fight time excluded from map time at town', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000); // 10s of real mapping

    feed(d, e, log.s13Start); // window opens — map freezes
    vi.advanceTimersByTime(30_000); // 30s in the minigame

    // Real-log commit sequence: window_close + abandon fire just before the
    // zone into the fight — the map resumes for ~0ms, then re-freezes.
    feed(d, e, log.s13WindowClose);
    feed(d, e, log.s13Abandon);
    feed(d, e, log.zoneTransition(MAP, VOREX_REWARD));
    expect(ctx(e).registry.map?.active).toBe(false);
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(true); // reward branch

    vi.advanceTimersByTime(60_000); // 60s fight/loot

    feed(d, e, log.zoneTransition(VOREX_REWARD, TOWN)); // always exits to town

    // Map finished with only the 10s of real mapping counted.
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).accumulatedMapTime).toBe(10_000);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
  });

  it('drops inside Vorex credit session and vorex only — vorex owns them, not the map', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    feed(d, e, log.bagUpdate(1, 200, 4));

    expect(ctx(e).registry.session?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.map?.snapshot().drops[200]).toBeUndefined(); // vorex owns the window
    expect(ctx(e).registry.seasonal('vorex')?.snapshot().drops[200]).toBe(4);
  });
});
