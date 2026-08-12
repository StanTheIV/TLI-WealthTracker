/**
 * Afterlight (S15 "ShouYe") — a bounded in-map encounter.
 *
 * Mob spawns drive a wave window whose expiry parks the tracker dormant; the
 * boss dying (or a Special's BGM stop) flips it terminal so the next expiry
 * finishes the run. Pickups never move it. The variant filter is the subtle
 * part — a wandering ghost appears *inside* an ongoing encounter and must not
 * disturb it.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Afterlight integration', () => {
  it('the warden appearing starts the tracker without pausing the map', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);

    expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(true);
    // In-map category — the map keeps running.
    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'afterlight')).toBe(true);
  });

  it('drops during the fight credit afterlight AND the map AND the session', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);
    feed(d, e, log.bagUpdate(1, 1000, 6));

    expect(ctx(e).registry.seasonal('afterlight')?.snapshot().drops[1000]).toBe(6);
    expect(ctx(e).registry.map?.snapshot().drops[1000]).toBe(6);
    expect(ctx(e).registry.session?.snapshot().drops[1000]).toBe(6);
    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.afterlight?.[1000]).toBe(6);
    expect(dbs.map?.[1000]).toBeUndefined();
  });

  it('the kill arms a loot window whose expiry finishes the tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);
    feed(d, e, log.afterlightEnd);

    expect(ctx(e).registry.seasonal('afterlight')?.isLootCollecting()).toBe(true);
    expect(events.some(ev => ev.type === 'loot_window_started' && ev.seasonalType === 'afterlight')).toBe(true);

    // The kill flipped expiry to finish, so this window ends the run.
    vi.advanceTimersByTime(5_000);

    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'afterlight')).toBe(true);
  });

  it('a pickup inside the loot window does NOT extend it', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);
    feed(d, e, log.afterlightEnd);

    // Only waves move the window. The drop is still credited — it just doesn't
    // buy the tracker more time.
    vi.advanceTimersByTime(4_500);
    feed(d, e, log.bagUpdate(1, 1000, 3));
    expect(ctx(e).registry.seasonal('afterlight')?.snapshot().drops[1000]).toBe(3);

    vi.advanceTimersByTime(600);
    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
  });

  it('a wandering ghost mid-encounter neither starts nor ends a tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    // Replays the real 05:51:03 → 05:51:26 sequence: the ghost appears nine
    // seconds into the warden fight. It has no _Win of its own, so treating it
    // as an encounter would strand a phantom tracker.
    feed(d, e, log.afterlightStart);
    feed(d, e, log.afterlightGhost);

    expect(events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'afterlight')).toHaveLength(1);

    // Still mid-fight: the window is a wave window, so expiry must park the
    // tracker dormant rather than end the run.
    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);

    feed(d, e, log.afterlightEnd);
    expect(ctx(e).registry.seasonal('afterlight')?.isLootCollecting()).toBe(true);
  });

  it('a ghost alone in a map starts nothing', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightGhost);

    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
  });

  it('the reward chest after the kill does not disturb the loot window', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);
    feed(d, e, log.afterlightEnd);
    const windowsBefore = events.filter(ev => ev.type === 'loot_window_started').length;

    feed(d, e, log.afterlightBox);

    expect(events.filter(ev => ev.type === 'loot_window_started')).toHaveLength(windowsBefore);
    expect(ctx(e).registry.seasonal('afterlight')?.isLootCollecting()).toBe(true);
  });

  it('the Bride variant drives the tracker exactly like the warden', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightBrideStart);

    expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(true);

    feed(d, e, log.afterlightBrideEnd);
    expect(ctx(e).registry.seasonal('afterlight')?.isLootCollecting()).toBe(true);
  });

  it('a second encounter in the same map folds in and leaves the live window intact', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);
    feed(d, e, log.afterlightEnd);

    vi.advanceTimersByTime(1_000);
    feed(d, e, log.afterlightStart);

    // One tracker, not two.
    expect(events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'afterlight')).toHaveLength(1);
    expect(ctx(e).registry.seasonal('afterlight')?.isLootCollecting()).toBe(true);

    // The folded encounter must NOT inherit the previous kill's finish-on-expiry:
    // its first spawn lull would otherwise destroy a fight still in progress.
    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('waves keep the fight alive and a lull only parks it dormant', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);

    // Waves every 4s — real encounters run 6-9 of them over ~22s.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(4_000);
      feed(d, e, log.afterlightWave);
      expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(true);
    }

    // Real logs contain spawn lulls of 12-99s. The run must survive one.
    vi.advanceTimersByTime(20_000);
    expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);

    feed(d, e, log.afterlightWave);
    expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(true);
    expect(events.filter(ev => ev.type === 'tracker_started'
      && ev.tracker.seasonalType === 'afterlight')).toHaveLength(1);
  });

  it('a Special variant ends on its BGM stop', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Real order: the BGM bracket opens before the boss row.
    feed(d, e, log.afterlightSpecialStart);
    feed(d, e, log.afterlightStart);
    feed(d, e, log.afterlightSpecialEnd);   // no _Win — 7 of 9 Specials log none

    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
    expect(events.filter(ev => ev.type === 'tracker_started'
      && ev.tracker.seasonalType === 'afterlight')).toHaveLength(1);
  });

  it('a plain Core encounter keeps the normal window', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.afterlightCoreStart);
    feed(d, e, log.afterlightStart);
    feed(d, e, log.afterlightEnd);

    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
  });

  it('a failed encounter (_Lose) ends the run like a kill', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);
    feed(d, e, log.afterlightLose);

    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'afterlight')).toBe(true);
  });

  it('a generic map mob is not an Afterlight wave', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.monsterCreated);

    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
  });

  it('pickups never extend the window, mid-fight or after', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);

    // Steady pickups mid-fight must NOT attest that waves are still coming.
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(2_000);
      feed(d, e, log.bagUpdate(1, 1000, i));
    }
    expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(false);
  });

  it('town entry finishes an encounter abandoned mid-fight', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.afterlightStart);
    // No _Win — the player left the map. Observed once across three real logs.
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'afterlight')).toBe(true);
  });

  it('an encounter outside a map starts nothing', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.afterlightStart);

    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
  });

  it('an encounter while the session is paused starts nothing', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 1000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    e.pause();
    feed(d, e, log.afterlightStart);

    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();
  });
});
