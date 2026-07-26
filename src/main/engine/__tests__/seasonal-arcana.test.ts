/**
 * Arcana (S9 "Tarot" / Fateful Contest) — minigame start, fight scene, finish.
 *
 * Timer starts at the Tarot Path minigame (`S9Taro Run`), continues into the
 * Fateful Contest fight scene (`SuMingTaLuo000`), and finishes when the player
 * leaves that scene. The fight scene lives under /Game/Art/Season/ but must NOT
 * spawn a generic map tracker — ArcanaHandler owns it (see classifyScene guard
 * in zone.ts).
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, ARCANA_FIGHT, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Arcana integration', () => {
  it('s9_minigame starts the arcana tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);

    expect(ctx(e).registry.seasonal('arcana')).toBeDefined();
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'arcana')).toBe(true);
  });

  it('entering the Fateful Contest scene does NOT create a map tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);

    // Commit to the fight — scene transition into SuMingTaLuo000.
    feed(d, e, log.zoneTransition(TOWN, ARCANA_FIGHT));

    // The arcana tracker continues; no phantom map tracker on top of it.
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
    expect(ctx(e).registry.map).toBeNull();
    expect(events.some(ev => ev.type === 'map_started')).toBe(false);
  });

  it('s9_fight without a prior minigame still starts the tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Fight);

    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
  });

  it('leaving the Fateful Contest scene finishes the arcana tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(TOWN, ARCANA_FIGHT));

    // Fight over — return to town.
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'arcana')).toBe(true);
  });

  it('drops inside the fight scene attribute to session and arcana, not a map tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(TOWN, ARCANA_FIGHT));

    feed(d, e, log.bagUpdate(1, 200, 4));

    expect(ctx(e).registry.session?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.seasonal('arcana')?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.map).toBeNull();
  });

  it('map-started arcana does NOT drop through to the frozen map', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.bagUpdate(1, 200, 2)); // pre-minigame: map loot

    // Opening the panel freezes the map for the whole interlude.
    feed(d, e, log.s9Minigame);
    expect(ctx(e).registry.map?.active).toBe(false);

    feed(d, e, log.bagUpdate(1, 200, 6)); // +4 inside the interlude

    expect(ctx(e).registry.seasonal('arcana')?.snapshot().drops[200]).toBe(4);
    // Frozen map keeps only its own pre-interlude loot — the tarot/fight
    // reward is not map yield.
    expect(ctx(e).registry.map?.snapshot().drops[200]).toBe(2);
    expect(ctx(e).registry.session?.snapshot().drops[200]).toBe(6);

    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.map?.[200]).toBe(2);
    expect(dbs.arcana?.[200]).toBe(4);
  });

  // --- Issue 1: closing the minigame mid-progress pauses the timer ----------

  it('s9_close pauses the arcana tracker (kept alive, not finished)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);

    // Back out of the Tarot panel without fighting.
    feed(d, e, log.s9Close);

    expect(ctx(e).registry.seasonal('arcana')).toBeDefined();  // still alive
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(false); // paused
    expect(ctx(e).registry.seasonalsSize()).toBe(1);
  });

  it('paused arcana tracker stops accruing elapsed while closed', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    vi.advanceTimersByTime(5_000);
    feed(d, e, log.s9Close);

    const atPause = ctx(e).registry.seasonal('arcana')!.elapsed();
    vi.advanceTimersByTime(30_000); // sit closed for 30s
    expect(ctx(e).registry.seasonal('arcana')!.elapsed()).toBe(atPause);
  });

  it('reopening the minigame (s9_minigame) resumes a closed tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.s9Close);
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(false);

    feed(d, e, log.s9Minigame); // reopen
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
    expect(ctx(e).registry.seasonalsSize()).toBe(1); // same tracker, not a new one
  });

  it('committing to the fight after a close resumes the tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.s9Close);
    feed(d, e, log.s9Fight); // reopen + commit

    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
  });

  // --- Interlude: the minigame panel itself pauses a running map -------------

  it('opening the tarot minigame on a map pauses the map; backing out resumes it', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000);

    feed(d, e, log.s9Minigame); // panel opens — map freezes
    expect(ctx(e).registry.map?.active).toBe(false);
    vi.advanceTimersByTime(30_000); // half a minute in the panel

    feed(d, e, log.s9Close); // backed out — map resumes, arcana pauses
    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(ctx(e).registry.map?.elapsed()).toBe(15_000); // panel time excluded
  });

  // --- Issue 2: entering the fight pauses a running map tracker --------------

  it('entering the fight from a map pauses the map tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP)); // running a map
    expect(ctx(e).registry.map?.active).toBe(true);

    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT)); // commit to fight

    expect(ctx(e).registry.map).not.toBeNull();
    expect(ctx(e).registry.map?.active).toBe(false); // paused, not finished
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);

    // The renderer must learn about the pause — a tracker_update with the
    // map snapshot frozen and active: false.
    const mapUpdates = events.filter(
      (ev): ev is Extract<EngineEvent, {type: 'tracker_update'}> =>
        ev.type === 'tracker_update' && ev.tracker.kind === 'map',
    );
    expect(mapUpdates.length).toBeGreaterThan(0);
    expect(mapUpdates[mapUpdates.length - 1].tracker.active).toBe(false);
  });

  it('returning to the map after the fight resumes the same map tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    const mapBefore = ctx(e).registry.map;
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT));

    // Leave the fight back into the same map.
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, MAP));

    expect(ctx(e).registry.map).toBe(mapBefore); // same instance, resumed
    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).registry.seasonalsSize()).toBe(0); // arcana finished

    // The resume must also be broadcast so the renderer un-freezes the row.
    const mapUpdates = events.filter(
      (ev): ev is Extract<EngineEvent, {type: 'tracker_update'}> =>
        ev.type === 'tracker_update' && ev.tracker.kind === 'map',
    );
    expect(mapUpdates[mapUpdates.length - 1].tracker.active).toBe(true);
  });

  it("map tracker elapsed excludes the fight duration", () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000); // 10s of map time

    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT));
    vi.advanceTimersByTime(60_000); // 60s fight — should NOT count toward map
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, MAP));
    vi.advanceTimersByTime(5_000); // 5s more map time

    // ~15s of map time, fight excluded.
    expect(ctx(e).registry.map?.elapsed()).toBe(15_000);
  });

  it('map-time accounting excludes the fight when returning to town', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT));
    vi.advanceTimersByTime(60_000); // fight
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, MAP));
    vi.advanceTimersByTime(5_000);
    feed(d, e, log.zoneTransition(MAP, TOWN)); // end the map

    // accumulatedMapTime should be ~15s, not 75s (fight excluded).
    expect(ctx(e).accumulatedMapTime).toBe(15_000);
  });

  it('fight -> straight to town: accumulatedMapTime excludes the fight', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000); // 10s of map time
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT));
    vi.advanceTimersByTime(60_000); // 60s fight

    // Exit the fight directly to town (no return to the map). ZoneHandler runs
    // first and folds the whole span into accumulatedMapTime; ArcanaHandler
    // must take the fight back out.
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, TOWN));

    expect(ctx(e).accumulatedMapTime).toBe(10_000);
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });

  it('entering the fight from town does not error (no map to pause)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(TOWN, ARCANA_FIGHT));
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, TOWN)); // back to town

    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });

  it('town -> arcana -> town finishes arcana exactly once (no double emit)', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(TOWN, ARCANA_FIGHT));
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, TOWN));

    // Both ZoneHandler (finishAllSeasonals) and ArcanaHandler act on this exit;
    // the second finish must be a no-op — exactly one tracker_finished.
    const finished = events.filter(
      ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'arcana',
    );
    expect(finished.length).toBe(1);
  });
});
