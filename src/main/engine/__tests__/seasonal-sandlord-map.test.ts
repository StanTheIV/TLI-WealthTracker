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
    feed(d, e, log.s10Wave);

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
    feed(d, e, log.s10Wave);
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
    feed(d, e, log.s10Wave);

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
    feed(d, e, log.s10Wave);
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
    feed(d, e, log.s10Wave);
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

  it('a quench keeps the tracker alive — the last wave\'s loot still credits', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Wave);

    // Quench fires per MACHINE, not per tile: measured across 41 quenches the
    // next wave followed within 5s in 37 cases (median 1.1s). Ending here would
    // strip the loot the just-quenched machine is still dropping.
    vi.advanceTimersByTime(3_000);
    feed(d, e, log.s10Quench);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);
    expect(ctx(e).registry.seasonal('sandlord')?.isLootCollecting()).toBe(true);

    feed(d, e, log.bagUpdate(1, 1000, 3));
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().drops[1000]).toBe(3);

    // A later machine simply extends the same run.
    vi.advanceTimersByTime(2_000);
    feed(d, e, log.s10Land);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);
  });

  it('an active tracker always has a live window', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Waves arrive in bursts, so most are swallowed by the reset throttle. A
    // swallowed reset must never leave the tracker running untimed — that is
    // what made a tile silently stop having a countdown.
    const check = (where: string) => {
      const t = ctx(e).registry.seasonal('sandlord');
      if (t && t.active && !t.isLootCollecting()) throw new Error(`untimed at ${where}`);
    };

    feed(d, e, log.s10Wave);                    check('start');
    vi.advanceTimersByTime(100);
    feed(d, e, log.s10Land);                    check('throttled burst wave');
    vi.advanceTimersByTime(100);
    feed(d, e, log.s10Quench);                  check('quench');
    vi.advanceTimersByTime(100);
    feed(d, e, log.s10Land);                    check('throttled wave after quench');
    vi.advanceTimersByTime(5_000);
    feed(d, e, log.s10Land);                    check('wave mid-window');
  });

  it('a quench with no follow-up wave finishes the run outright', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Wave);
    feed(d, e, log.s10Quench);

    // The last machine quenched and nothing followed — the tile is done.
    vi.advanceTimersByTime(10_100);
    expect(ctx(e).registry.seasonal('sandlord')).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_finished'
      && ev.tracker.seasonalType === 'sandlord')).toBe(true);
  });

  it('walking away mid-tile only parks the run — a later wave resumes it', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s10Wave);

    // No quench — the machine is still live, the player just left.
    vi.advanceTimersByTime(10_100);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);

    feed(d, e, log.s10Land);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);
    expect(events.filter(ev => ev.type === 'tracker_started'
      && ev.tracker.seasonalType === 'sandlord').length).toBe(1);
  });

  it('a quench followed by another machine keeps one continuous run', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Real tiles interleave several machines: 8 quenches in one 14s encounter.
    feed(d, e, log.s10Wave);
    feed(d, e, log.s10Quench);
    vi.advanceTimersByTime(1_100);
    feed(d, e, log.s10WaveResource); // second machine — clears the terminal flag
    feed(d, e, log.s10Quench);
    vi.advanceTimersByTime(1_100);
    feed(d, e, log.s10Wave);

    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
    expect(events.filter(ev => ev.type === 'tracker_started'
      && ev.tracker.seasonalType === 'sandlord').length).toBe(1);

    // And now the tile really ends.
    feed(d, e, log.s10Quench);
    vi.advanceTimersByTime(10_100);
    expect(ctx(e).registry.seasonal('sandlord')).toBeNull();
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
    feed(d, e, log.s10Wave);

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
    feed(d, e, log.s10Wave);

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
    feed(d, e, log.s10Wave);
    feed(d, e, log.bagUpdate(1, 1000, 2));
    vi.advanceTimersByTime(10_100); // dormant

    feed(d, e, log.s10Wave);
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(true);

    feed(d, e, log.bagUpdate(1, 1000, 5)); // +3 inside the new window
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().drops[1000]).toBe(5);

    const starts = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'sandlord');
    expect(starts).toHaveLength(1);
  });

  it('a second tile in the same map resumes the same tracker — no second start', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.s10Wave);
    feed(d, e, log.s10Quench);      // first machine done
    feed(d, e, log.s10Wave);        // second machine / later tile

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
    feed(d, e, log.s10Wave);
    feed(d, e, log.s10Quench); // still alive — must be torn down regardless

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
    feed(d, e, log.s10Wave);
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
    feed(d, e, log.s10Wave);
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
