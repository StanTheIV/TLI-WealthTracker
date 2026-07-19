/**
 * Session pause/resume must freeze ALL live trackers (map + seasonals), not
 * just the session tracker (Defect A1), and the zone state machine must keep
 * OBSERVING transitions while paused so a map/seasonal that ends mid-pause
 * still finishes and no tracker is left stuck paused (Defect A2).
 *
 * Follows the style of seasonal-arcana.test.ts / reset.test.ts and drives the
 * full dispatcher → engine pipeline via the shared seasonal fixtures.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {
  boot, createDispatcher, createEngine, ctx, feed, log,
  ARCANA_FIGHT, MAP, TOWN,
} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

// ---------------------------------------------------------------------------
// A1 — pause freezes map + seasonal elapsed
// ---------------------------------------------------------------------------

describe('Session pause freezes the map tracker (A1)', () => {
  it('map elapsed and session elapsed both exclude the paused span', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(20_000); // 20s of live map time

    const sessionBefore = ctx(e).registry.session!.elapsed();
    const mapBefore     = ctx(e).registry.map!.elapsed();
    expect(mapBefore).toBe(20_000);

    e.pause();
    vi.advanceTimersByTime(60_000); // 60s paused — must not count anywhere
    // Frozen: elapsed unchanged while paused.
    expect(ctx(e).registry.map!.active).toBe(false);
    expect(ctx(e).registry.map!.elapsed()).toBe(mapBefore);
    expect(ctx(e).registry.session!.elapsed()).toBe(sessionBefore);

    e.resume();
    vi.advanceTimersByTime(10_000); // 10s more live map time

    expect(ctx(e).registry.map!.elapsed()).toBe(30_000);       // 20 + 10, no 60
    expect(ctx(e).registry.session!.elapsed()).toBe(sessionBefore + 10_000);
  });

  it('accumulatedMapTime at town entry excludes the paused span', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(20_000);
    e.pause();
    vi.advanceTimersByTime(60_000);
    e.resume();
    vi.advanceTimersByTime(10_000);
    feed(d, e, log.zoneTransition(MAP, TOWN)); // end the map

    expect(ctx(e).accumulatedMapTime).toBe(30_000); // fight-free, pause-free
  });
});

describe('Session pause freezes an active seasonal too (A1)', () => {
  it('both map and seasonal freeze during pause and both resume', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    // Start a map, then an overrealm seasonal on top of it.
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    vi.advanceTimersByTime(15_000);

    const map      = ctx(e).registry.map!;
    const seasonal = ctx(e).registry.seasonal('overrealm')!;
    expect(map.active).toBe(true);
    expect(seasonal.active).toBe(true);
    const mapAt = map.elapsed();
    const seaAt = seasonal.elapsed();

    e.pause();
    expect(map.active).toBe(false);
    expect(seasonal.active).toBe(false);

    vi.advanceTimersByTime(45_000); // paused
    expect(map.elapsed()).toBe(mapAt);
    expect(seasonal.elapsed()).toBe(seaAt);

    e.resume();
    expect(map.active).toBe(true);
    expect(seasonal.active).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(map.elapsed()).toBe(mapAt + 5_000);
    expect(seasonal.elapsed()).toBe(seaAt + 5_000);
  });

  it('emits tracker_update marking the map/seasonal frozen then unfrozen', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);

    const before = events.length;
    e.pause();
    const pausedUpdates = events.slice(before).filter(
      (ev): ev is Extract<EngineEvent, {type: 'tracker_update'}> => ev.type === 'tracker_update',
    );
    // Both map and seasonal report active:false on pause.
    expect(pausedUpdates.some(u => u.tracker.kind === 'map' && !u.tracker.active)).toBe(true);
    expect(pausedUpdates.some(u => u.tracker.kind === 'seasonal' && !u.tracker.active)).toBe(true);

    const beforeResume = events.length;
    e.resume();
    const resumedUpdates = events.slice(beforeResume).filter(
      (ev): ev is Extract<EngineEvent, {type: 'tracker_update'}> => ev.type === 'tracker_update',
    );
    expect(resumedUpdates.some(u => u.tracker.kind === 'map' && u.tracker.active)).toBe(true);
    expect(resumedUpdates.some(u => u.tracker.kind === 'seasonal' && u.tracker.active)).toBe(true);
  });
});

describe('Session resume does not resume a self-paused seasonal (A1)', () => {
  it('an arcana tracker closed BEFORE pause stays paused after resume', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    // Start arcana, then self-pause it (backed out of the Tarot panel).
    feed(d, e, log.s9Minigame);
    feed(d, e, log.s9Close);
    expect(ctx(e).registry.seasonal('arcana')!.active).toBe(false); // self-paused

    e.pause();
    expect(ctx(e).registry.seasonal('arcana')!.active).toBe(false);
    e.resume();

    // The engine only resumes seasonals IT paused — this one stays paused.
    expect(ctx(e).registry.seasonal('arcana')!.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2 — zone transitions observed while paused
// ---------------------------------------------------------------------------

describe('Zone transition to town while paused (A2)', () => {
  it('finishes the map, clears inMap, updates scene, excludes paused span', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(25_000); // 25s live map time

    e.pause();
    vi.advanceTimersByTime(60_000); // sit paused for 60s

    const finishedBefore = events.filter(
      ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'map',
    ).length;

    // Walk to town WHILE still paused.
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).inMap).toBe(false);
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).currentScene).toBe(TOWN);
    const finishedAfter = events.filter(
      ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'map',
    ).length;
    expect(finishedAfter).toBe(finishedBefore + 1); // map finished during pause

    // accumulatedMapTime is the 25s of live time, not 85s.
    expect(ctx(e).accumulatedMapTime).toBe(25_000);

    // Resume must not error and must not resurrect the (gone) map.
    e.resume();
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).inMap).toBe(false);
  });

  it('a fresh map entered WHILE paused does not accrue during the pause', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    e.pause();
    // Walk into a map while paused — the tracker must be created frozen.
    feed(d, e, log.zoneTransition(TOWN, MAP));
    expect(ctx(e).inMap).toBe(true);
    expect(ctx(e).registry.map!.active).toBe(false);

    vi.advanceTimersByTime(40_000); // paused map time — must not count
    expect(ctx(e).registry.map!.elapsed()).toBe(0);

    e.resume();
    expect(ctx(e).registry.map!.active).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(ctx(e).registry.map!.elapsed()).toBe(10_000); // only post-resume time
  });
});

describe('Pause during an Arcana fight, leave the fight while paused (A2)', () => {
  it('the map is NOT left stuck paused after resume', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP)); // running a map
    vi.advanceTimersByTime(10_000);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT)); // map paused for the fight
    expect(ctx(e).registry.map!.active).toBe(false);

    // Pause the whole session mid-fight.
    e.pause();
    vi.advanceTimersByTime(30_000);

    // Leave the fight back to the map WHILE still paused. ArcanaHandler must
    // resolve its fight-pause bookkeeping even though the session is paused.
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, MAP));
    expect(ctx(e).registry.seasonalsSize()).toBe(0); // arcana finished
    // Still paused → map still frozen (handed to the session pause).
    expect(ctx(e).registry.map!.active).toBe(false);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();

    // Resuming the session must bring the map back — not leave it stuck.
    e.resume();
    expect(ctx(e).registry.map).not.toBeNull();
    expect(ctx(e).registry.map!.active).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(ctx(e).registry.map!.elapsed()).toBe(15_000); // 10s pre-fight + 5s post-resume
  });

  it('resuming mid-fight (still in the fight scene) leaves the map paused', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT)); // map paused for fight
    e.pause();
    e.resume(); // resume WITHOUT leaving the fight

    // Fight is still ongoing (ctx.mapPausedForInterludeAt set) → map stays paused.
    expect(ctx(e).mapPausedForInterludeAt).not.toBeNull();
    expect(ctx(e).registry.map!.active).toBe(false);

    // Leaving the fight now resumes the map as normal.
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, MAP));
    expect(ctx(e).registry.map!.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pause suppresses drops (crediting) end-to-end
// ---------------------------------------------------------------------------

describe('Drops are suppressed while paused', () => {
  it('bag deltas during pause credit no tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.bagUpdate(1, 100, 5)); // 5 picked up live
    expect(ctx(e).registry.map!.snapshot().drops[100]).toBe(5);

    e.pause();
    feed(d, e, log.bagUpdate(1, 100, 12)); // +7 while paused — suppressed
    e.resume();

    // Map still shows only the 5 credited before the pause.
    expect(ctx(e).registry.map!.snapshot().drops[100]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Loot windows freeze with the session pause — remaining time is preserved
// ---------------------------------------------------------------------------

describe('Loot windows freeze during a session pause', () => {
  it('Lunaria window survives a long pause and continues with remaining time', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum); // lunaria starts, pausing loot window armed (5s)
    vi.advanceTimersByTime(2_000); // 3s of window left

    e.pause();
    vi.advanceTimersByTime(60_000); // long AFK — frozen window must NOT expire
    e.resume();

    // Window continues where it left off: lunaria is active and collecting.
    const lunaria = ctx(e).registry.seasonal('lunaria')!;
    expect(lunaria.active).toBe(true);
    expect(lunaria.isLootCollecting()).toBe(true);

    // The remaining ~3s now run out in real time → lunaria self-pauses
    // (dormant between strums) exactly as if the pause never happened.
    vi.advanceTimersByTime(3_100);
    expect(lunaria.active).toBe(false);
    expect(ctx(e).registry.seasonal('lunaria')).not.toBeNull(); // paused, not finished
  });

  it('Carjack window survives a pause; expiry after resume finishes it', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11End); // combat over → 5s loot window armed

    e.pause();
    vi.advanceTimersByTime(300_000); // 5min AFK mid-window
    e.resume();

    // Still alive and collecting after resume — the pause didn't eat the window.
    expect(ctx(e).registry.seasonal('carjack')).not.toBeNull();
    expect(ctx(e).registry.seasonal('carjack')!.isLootCollecting()).toBe(true);

    // Remaining window elapses in real time → carjack finishes as normal.
    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonal('carjack')).toBeNull();
  });

  it('resume republishes the loot deadline for the overlay countdown', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 400, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    feed(d, e, log.s11End);

    const before = events.filter(ev => ev.type === 'loot_window_started').length;
    e.pause();
    e.resume();
    const after = events.filter(ev => ev.type === 'loot_window_started').length;
    expect(after).toBe(before + 1); // fresh deadline emitted on unfreeze
  });
});
