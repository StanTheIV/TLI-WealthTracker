/**
 * Hunting (SixGod) — statue arms, boss-start commits.
 *
 * The arena has no zone transition of its own, so the statue alone must never
 * start a tracker: only the boss-start line that follows it does.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Hunting integration', () => {
  it('a statue alone starts nothing', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);

    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'hunting')).toBe(false);
  });

  it('statue then boss_start starts the hunting tracker without pausing the map', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);
    feed(d, e, log.huntingBossStart);

    expect(ctx(e).registry.seasonal('hunting')?.active).toBe(true);
    // In-map category — the map keeps running.
    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'hunting')).toBe(true);
  });

  it('drops during the fight credit hunting AND the map AND the session', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);
    feed(d, e, log.huntingBossStart);
    feed(d, e, log.bagUpdate(1, 1000, 6));

    expect(ctx(e).registry.seasonal('hunting')?.snapshot().drops[1000]).toBe(6);
    expect(ctx(e).registry.map?.snapshot().drops[1000]).toBe(6);
    expect(ctx(e).registry.session?.snapshot().drops[1000]).toBe(6);
    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.hunting?.[1000]).toBe(6);
    expect(dbs.map?.[1000]).toBeUndefined();
  });

  it('boss_start with no prior statue starts nothing', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingBossStart);

    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
  });

  it('a zone change between statue and boss_start clears the arm', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);
    feed(d, e, log.zoneTransition(MAP, TOWN));
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingBossStart);

    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
  });

  it('a boss_start swallowed by a session pause consumes the arm', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);

    // The arena opens (and the boss dies) during the pause — no run is
    // credited, but the arm must not survive to commit a later BossStatus1.
    e.pause();
    feed(d, e, log.huntingBossStart);
    feed(d, e, log.huntingBossEnd);
    e.resume();

    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
    feed(d, e, log.huntingBossStart);
    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
  });

  it('a statue in town does not arm — a later boss_start starts nothing', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.huntingStatue); // still in town, no map tracker
    feed(d, e, log.huntingBossStart);

    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
  });

  it('duplicate boss_end lines arm the loot window exactly once', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);
    feed(d, e, log.huntingBossStart);
    events.length = 0;

    // The game emits BossStatus0 twice ~160ms apart.
    feed(d, e, log.huntingBossEnd);
    vi.advanceTimersByTime(160);
    feed(d, e, log.huntingBossEnd);

    const armed = events.filter(ev => ev.type === 'loot_window_started' && ev.seasonalType === 'hunting');
    expect(armed).toHaveLength(1);

    // The second line must not have pushed the deadline out: the window still
    // expires 5s after the FIRST one (160ms already elapsed).
    vi.advanceTimersByTime(4_800);
    expect(ctx(e).registry.seasonal('hunting')).not.toBeNull();
    vi.advanceTimersByTime(100);
    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
  });

  it('loot window expiry finishes the tracker (does NOT just pause it)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);
    feed(d, e, log.huntingBossStart);
    feed(d, e, log.huntingBossEnd);

    vi.advanceTimersByTime(5_100);

    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'hunting')).toBe(true);
    // The map is untouched by the seasonal ending.
    expect(ctx(e).registry.map?.active).toBe(true);
  });

  it('pickups inside the loot window are credited and refresh it (decaying)', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);
    feed(d, e, log.huntingBossStart);
    feed(d, e, log.huntingBossEnd);

    vi.advanceTimersByTime(4_500);
    feed(d, e, log.bagUpdate(1, 1000, 3));
    expect(ctx(e).registry.seasonal('hunting')?.snapshot().drops[1000]).toBe(3);

    // Standard decaying refresh: the pickup re-armed the window to 80% of 5s,
    // so the tracker survives the original deadline and expires ~4s later.
    vi.advanceTimersByTime(600);
    expect(ctx(e).registry.seasonal('hunting')).not.toBeNull();
    vi.advanceTimersByTime(3_500);
    expect(ctx(e).registry.seasonal('hunting')).toBeNull();
    // The drop also landed on the map (drop-through).
    expect(ctx(e).registry.map?.snapshot().drops[1000]).toBe(3);
  });

  it('town entry mid-fight finishes the tracker via ZoneHandler', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.huntingStatue);
    feed(d, e, log.huntingBossStart);

    feed(d, e, log.zoneTransition(MAP, TOWN)); // left without killing the boss

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'hunting')).toBe(true);
  });
});
