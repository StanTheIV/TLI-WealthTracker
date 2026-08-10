/**
 * Sandlord (S10) in-map coin tile — the 'map'-phase half of the seasonal.
 *
 * Shares the seasonal type with the hub bubble but is an in-map mechanic: the
 * map keeps running, drops fall through, and the wave window (not a loot
 * window — pickups never refresh it) pauses the tracker on expiry.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {
  boot, createDispatcher, createEngine, ctx, feed, log,
  MAP, SANDLORD_HUB, TOWN,
} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Sandlord in-map tile integration', () => {
  it('a tile in a regular map starts a map-phase sandlord tracker without pausing the map', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);

    const t = ctx(e).registry.seasonal('sandlord');
    expect(t).not.toBeNull();
    expect(t?.active).toBe(true);
    expect(t?.snapshot().phase).toBe('map');
    expect(t?.ownsBubble).toBe(false);
    // In-map category — the map must keep running.
    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'sandlord')).toBe(true);
    expect(events.some(ev => ev.type === 'loot_window_started' && ev.seasonalType === 'sandlord')).toBe(true);
  });

  it('drops credit sandlord AND the map AND the session (drop-through)', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);
    feed(d, e, log.bagUpdate(1, 1000, 4));

    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().drops[1000]).toBe(4);
    expect(ctx(e).registry.map?.snapshot().drops[1000]).toBe(4);
    expect(ctx(e).registry.session?.snapshot().drops[1000]).toBe(4);
    // Breakdown stays single-owner so the by-source pie sums to session FE.
    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.sandlord?.[1000]).toBe(4);
    expect(dbs.map?.[1000]).toBeUndefined();
  });

  it('a wave resets the window — the tracker outlives the original deadline', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);

    // 9.5s into the 10s window — 0.5s from expiry.
    vi.advanceTimersByTime(9_500);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);

    feed(d, e, log.s10Wave); // full re-arm

    // t=19.4s overall, long past the original 10s deadline — still alive.
    vi.advanceTimersByTime(9_900);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);

    vi.advanceTimersByTime(200);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(false);
  });

  it('mob landings keep the window alive across a single-machine multi-round event', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Real-log shape (2026.08.10 05:52): one tile, ONE Machine_Active for the
    // whole event, then mob rounds landing at ~9s intervals with no further
    // Machine marker. The landings alone must carry the window.
    feed(d, e, log.s10Tile);
    feed(d, e, log.s10Wave);
    for (let round = 0; round < 3; round++) {
      vi.advanceTimersByTime(9_000);
      feed(d, e, log.s10Land);
      expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);
    }

    vi.advanceTimersByTime(10_100); // rounds over — now it may expire
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(false);
  });

  it('rate-limits resets during a dense landing burst', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);
    events.length = 0;

    // A burst lands ~30 mobs/sec; only ~1 reset/sec may reach the overlay.
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(33);
      feed(d, e, log.s10Land);
    }

    const resets = events.filter(ev => ev.type === 'loot_window_started' && ev.seasonalType === 'sandlord');
    expect(resets.length).toBeLessThanOrEqual(2); // ~2s of burst
    expect(resets.length).toBeGreaterThan(0);
  });

  it('an early quench self-heals — the next landing resumes the tracker', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);

    // One machine quenches while another is still spawning rounds.
    vi.advanceTimersByTime(3_000);
    feed(d, e, log.s10Quench);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(false);

    vi.advanceTimersByTime(2_000);
    feed(d, e, log.s10Land);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);

    feed(d, e, log.bagUpdate(1, 1000, 3)); // post-resume drops still credit
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().drops[1000]).toBe(3);
  });

  it('a wave with no tracker starts one defensively (tile line missed mid-map)', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10WaveResource); // no preceding tile

    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().phase).toBe('map');
  });

  it('bag_update does NOT refresh the window — pickups alone let it expire', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);

    // Steady pickups across the whole window. Under Lunaria's rules these would
    // keep re-arming it; here only waves count, so it must still expire on time.
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(2_000);
      feed(d, e, log.bagUpdate(1, 1000, i));
    }

    vi.advanceTimersByTime(100);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(false);
  });

  it('window expiry pauses the tracker (does NOT finish it)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);

    vi.advanceTimersByTime(10_100);

    expect(ctx(e).registry.seasonal('sandlord')).not.toBeNull();
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'sandlord')).toBe(false);
    expect(events.some(ev => ev.type === 'loot_window_ended' && ev.seasonalType === 'sandlord')).toBe(true);
  });

  it('a late wave resumes the same dormant tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);
    feed(d, e, log.bagUpdate(1, 1000, 2));
    vi.advanceTimersByTime(10_100); // dormant

    feed(d, e, log.s10Wave);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);

    feed(d, e, log.bagUpdate(1, 1000, 5)); // +3 inside the new window
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().drops[1000]).toBe(5);

    const starts = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'sandlord');
    expect(starts).toHaveLength(1);
  });

  it('a quench pauses the tracker immediately', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);

    vi.advanceTimersByTime(1_000); // well inside the window
    feed(d, e, log.s10Quench);

    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(false);
    expect(ctx(e).registry.seasonal('sandlord')?.isLootCollecting()).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'sandlord')).toBe(false);
  });

  it('a second tile in the same map resumes the same tracker — no second start', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.s10Tile);
    feed(d, e, log.s10Quench);      // first tile done, dormant
    feed(d, e, log.s10Tile);        // second tile

    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);
    expect(ctx(e).registry.seasonalsSize()).toBe(1);
    const starts = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'sandlord');
    expect(starts).toHaveLength(1);
  });

  it('town entry finishes the tile tracker via ZoneHandler', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Tile);
    feed(d, e, log.s10Quench); // dormant — must still be torn down

    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'sandlord')).toBe(true);
  });

  it('tile / wave / quench are ignored while the hub bubble is up', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));
    events.length = 0;

    // The hub's Pillage minigame replays these markers densely.
    feed(d, e, log.s10Tile);
    feed(d, e, log.s10Wave);
    feed(d, e, log.s10Quench);

    // The bubble is untouched — still active, still phase 'hub'.
    const t = ctx(e).registry.seasonal('sandlord');
    expect(t?.ownsBubble).toBe(true);
    expect(t?.snapshot().phase).toBe('hub');
    expect(t?.active).toBe(true);
    expect(events.some(ev => ev.type === 'loot_window_started')).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === 'sandlord')).toBe(false);
  });

  it('map → hub with a dormant tile tracker: map freezes, tile run ends, bubble starts', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000); // 10s of real mapping
    feed(d, e, log.s10Tile);
    feed(d, e, log.s10Quench);      // tile run goes dormant, still registered
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().phase).toBe('map');
    events.length = 0;

    feed(d, e, log.zoneTransition(MAP, SANDLORD_HUB));

    // The lingering map-phase run must not suppress the hub bubble.
    const t = ctx(e).registry.seasonal('sandlord');
    expect(t?.ownsBubble).toBe(true);
    expect(t?.snapshot().phase).toBe('hub');
    expect(t?.active).toBe(true);
    // The map froze for the whole Sandlord run (own-area category).
    expect(ctx(e).registry.map?.active).toBe(false);
    expect(ctx(e).mapPausedForInterludeAt).not.toBeNull();

    const finished = events.filter(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'sandlord');
    expect(finished).toHaveLength(1);
    expect(finished[0].type === 'tracker_finished' && finished[0].tracker.phase).toBe('map');

    // Town return closes the bubble and the map keeps only its pre-hub time.
    vi.advanceTimersByTime(30_000);
    feed(d, e, log.zoneTransition(SANDLORD_HUB, TOWN));
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(ctx(e).accumulatedMapTime).toBe(10_000);
  });
});
