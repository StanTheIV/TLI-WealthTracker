/**
 * Step 1.4 — adversarial cases for the loot-window wake rule
 * (`TrackerRegistry.wakeForLoot`, see dormant-terminal-wake.test.ts).
 *
 * Everything runs the production chain (dispatcher -> engine -> handlers) under
 * fake timers, except the few registry-level edge cases that need a stamp the
 * log chain cannot place precisely. The last block covers an in-map window that
 * finishes while the player is in a seasonal scene (Arcana fight).
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {EngineEvent, SeasonalType} from '@/shared/contracts/engine';
import {TrackerRegistry} from '@/main/engine/tracker-registry';
import {
  TEST_IDENTITY,
  ARCANA_FIGHT, boot, createDispatcher, createEngine, ctx, feed, internalEmit, log, MAP, SANDLORD_HUB, TOWN,
} from './seasonal-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const ITEM = 1000;

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 0}]);
  feed(d, e, log.zoneTransition(TOWN, MAP));
  let total = 0;
  const line = (l: string) => feed(d, e, l);
  const bag  = (n: number) => { total += n; line(log.bagUpdate(1, ITEM, total)); };
  const adv  = (ms: number) => vi.advanceTimersByTime(ms);
  const reg  = () => ctx(e).registry;
  return {events, d, e, line, bag, adv, reg};
}

const windows  = (events: EngineEvent[], type: SeasonalType) =>
  events.filter(ev => ev.type === 'loot_window_started' && ev.seasonalType === type);
const started  = (events: EngineEvent[], type: SeasonalType) =>
  events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === type);
const finished = (events: EngineEvent[], type: SeasonalType) =>
  events.filter(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === type);
const updates  = (events: EngineEvent[], type: SeasonalType) =>
  events.filter(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === type);

function finishedSnap(events: EngineEvent[], type: SeasonalType) {
  const f = finished(events, type)[0];
  if (!f || f.type !== 'tracker_finished') throw new Error(`no tracker_finished for ${type}`);
  return f.tracker;
}

/** The last published `owner` flag for a seasonal. */
function lastOwner(events: EngineEvent[], type: SeasonalType): boolean | undefined {
  const all = events.filter(ev =>
    (ev.type === 'tracker_update' || ev.type === 'tracker_started') && ev.tracker.seasonalType === type);
  const last = all[all.length - 1];
  return last && (last.type === 'tracker_update' || last.type === 'tracker_started') ? last.tracker.owner : undefined;
}

// ---------------------------------------------------------------------------
// 1. No zombie revival
// ---------------------------------------------------------------------------

describe('no zombie revival after the run is torn down', () => {
  it('town entry on a dormant carjack: late Stop / wave / stale handle revive nothing, no duplicate tracker_started', () => {
    const {events, line, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    const stale = reg().seasonal('carjack')!;
    expect(stale.active).toBe(false);

    line(log.zoneTransition(MAP, TOWN));
    expect(reg().seasonal('carjack')).toBeNull();
    expect(finished(events, 'carjack')).toHaveLength(1);

    events.length = 0;
    line(log.s11End);
    line(log.s11Wave);
    adv(1_500);
    line(log.s11Wave);
    stale.armLootTimer();
    stale.resetLootTimer();
    expect(stale.resetLootTimerThrottled()).toBe(false);
    adv(60_000);

    expect(events).toEqual([]);
    expect(stale.active).toBe(false);
    expect(stale.isLootCollecting()).toBe(false);
    expect(reg().seasonalsSize()).toBe(0);
  });

  it('town entry mid woken window: the timer dies with the run, no second finish, no stray window end', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);                                  // wakes, terminal window in flight
    bag(2);
    adv(1_000);

    line(log.zoneTransition(MAP, TOWN));
    expect(finished(events, 'carjack')).toHaveLength(1);
    expect(finishedSnap(events, 'carjack').drops[ITEM]).toBe(2);

    events.length = 0;
    adv(60_000);
    expect(events).toEqual([]);
    expect(reg().seasonalsSize()).toBe(0);
  });

  it('a stale handle from the previous map cannot touch the next map\'s tracker of the same type', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    const stale = reg().seasonal('carjack')!;
    line(log.zoneTransition(MAP, TOWN));
    line(log.zoneTransition(TOWN, MAP));
    line(log.s11Start);
    const fresh = reg().seasonal('carjack')!;
    expect(fresh).not.toBe(stale);
    expect(started(events, 'carjack')).toHaveLength(2);

    adv(5_100);                                        // fresh parks
    expect(fresh.active).toBe(false);
    const windowsBefore = windows(events, 'carjack').length;
    stale.armLootTimer();
    stale.resetLootTimer();
    expect(stale.resetLootTimerThrottled()).toBe(false);
    expect(fresh.active).toBe(false);
    expect(windows(events, 'carjack')).toHaveLength(windowsBefore);
    bag(1);
    expect(fresh.snapshot().drops[ITEM]).toBeUndefined();
  });

  it('a woken terminal window that expires finishes the run for good: later Stop / wave / handle revive nothing', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);
    bag(1);
    adv(5_100);
    expect(reg().seasonal('carjack')).toBeNull();
    expect(finished(events, 'carjack')).toHaveLength(1);

    events.length = 0;
    line(log.s11End);
    line(log.s11Wave);
    line(log.s11Start);                                // a NEW encounter is a legitimate fresh start
    expect(started(events, 'carjack')).toHaveLength(1);
    expect(finished(events, 'carjack')).toHaveLength(0);
    expect(reg().seasonal('carjack')?.snapshot().elapsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Session pause
// ---------------------------------------------------------------------------

const MECHANICS = [
  {name: 'sandlord-map quench', type: 'sandlord' as SeasonalType, setup: [log.s10Wave],         parkMs: 10_100, marker: log.s10Quench},
  {name: 'afterlight end',      type: 'afterlight' as SeasonalType, setup: [log.afterlightStart], parkMs: 5_100, marker: log.afterlightEnd},
  {name: 'afterlight special',  type: 'afterlight' as SeasonalType, setup: [log.afterlightStart], parkMs: 5_100, marker: log.afterlightSpecialStart},
  {name: 'carjack Stop',        type: 'carjack' as SeasonalType, setup: [log.s11Start],         parkMs: 5_100, marker: log.s11End},
  {name: 'lunaria strum',       type: 'lunaria' as SeasonalType, setup: [log.s14Strum],         parkMs: 5_100, marker: log.s14Strum},
  {name: 'clockwork turn-in',   type: 'clockwork' as SeasonalType, setup: [log.s7Podium],       parkMs: 0,     marker: log.s7Turnin},
];

describe.each(MECHANICS)('paused: $name on a dormant tracker', ({type, setup: lines, parkMs, marker}) => {
  it('credits nothing and arms nothing across pause and resume, and the lost marker does not latch', () => {
    const {events, e, line, bag, adv, reg} = setup();
    for (const l of lines) line(l);
    adv(parkMs);
    expect(reg().seasonal(type)?.active).toBe(false);

    e.pause();
    events.length = 0;
    line(marker);
    bag(3);
    adv(120_000);
    expect(reg().seasonal(type)?.active).toBe(false);
    expect(reg().seasonal(type)?.isLootCollecting()).toBe(false);
    expect(windows(events, type)).toHaveLength(0);

    e.resume();
    adv(120_000);
    bag(2);
    expect(reg().seasonal(type)?.active).toBe(false);
    expect(reg().seasonal(type)?.snapshot().drops[ITEM]).toBeUndefined();
    expect(windows(events, type)).toHaveLength(0);
    expect(finished(events, type)).toHaveLength(0);

    // The marker that was swallowed by the pause left no latch behind: the same
    // marker after the resume wakes the run and credits it.
    line(marker);
    expect(reg().seasonal(type)?.active).toBe(true);
    bag(4);
    expect(reg().seasonal(type)?.snapshot().drops[ITEM]).toBe(4);
    expect(windows(events, type)).toHaveLength(1);
  });

  it('a run that was never woken ends at town entry with an empty credit', () => {
    const {events, e, line, bag, adv, reg} = setup();
    for (const l of lines) line(l);
    adv(parkMs);
    e.pause();
    line(marker);
    e.resume();
    bag(5);
    line(log.zoneTransition(MAP, TOWN));
    expect(reg().seasonal(type)).toBeNull();
    expect(finishedSnap(events, type).drops[ITEM]).toBeUndefined();
  });
});

describe('pause while a woken window is in flight', () => {
  it('carjack: window frozen with its remaining time, no expiry during the pause, resumes and finishes on schedule', () => {
    const {events, e, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_000);                                        // parks at exactly 5000 (elapsed 5000)
    expect(reg().seasonal('carjack')?.active).toBe(false);

    line(log.s11End);                                  // wake, 5s terminal window
    bag(2);
    adv(2_000);
    e.pause();
    expect(reg().seasonal('carjack')?.active).toBe(false);
    expect(reg().seasonal('carjack')?.isLootCollecting()).toBe(true);

    adv(120_000);
    bag(7);                                            // discarded by the pause
    expect(finished(events, 'carjack')).toHaveLength(0);

    events.length = 0;
    e.resume();
    expect(reg().seasonal('carjack')?.active).toBe(true);
    const w = windows(events, 'carjack');
    expect(w).toHaveLength(1);
    if (w[0].type === 'loot_window_started') expect(w[0].deadline - w[0].timestamp).toBe(3_000);

    adv(2_999);
    expect(finished(events, 'carjack')).toHaveLength(0);
    adv(2);
    expect(finished(events, 'carjack')).toHaveLength(1);
    const snap = finishedSnap(events, 'carjack');
    expect(snap.drops[ITEM]).toBe(2);
    expect(snap.elapsed).toBe(10_000);                 // 5000 before dormancy + 2000 + 3000, pause excluded
  });

  it('sandlord-map: the woken tracker keeps ownership across the pause/resume (order restored, not bumped)', () => {
    const {e, line, bag, adv, reg} = setup();
    line(log.s10Wave);
    adv(10_100);
    line(log.s11Start);                                // carjack started later
    adv(300);
    line(log.s10Quench);                               // sandlord woken, owns
    expect(reg().writer()).toBe('sandlord');

    e.pause();
    e.resume();
    expect(reg().writer()).toBe('sandlord');
    bag(2);
    expect(reg().seasonal('sandlord')?.snapshot().drops[ITEM]).toBe(2);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBeUndefined();
  });

  it('pausing and resuming twice mid-window preserves the remaining time cumulatively', () => {
    const {events, e, line, adv} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);
    adv(1_000);
    e.pause(); adv(30_000); e.resume();
    adv(1_000);
    e.pause(); adv(30_000); e.resume();
    adv(2_999);                                        // 1000 + 1000 + 2999 < 5000 - 1
    expect(finished(events, 'carjack')).toHaveLength(0);
    adv(2);
    expect(finished(events, 'carjack')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Engine.reset
// ---------------------------------------------------------------------------

describe('Engine.reset around a woken window', () => {
  it('mid-window: the run finishes once with its credit, the timer is dead, the new session is clean', () => {
    const {events, e, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);
    bag(2);

    events.length = 0;
    e.reset(TEST_IDENTITY);
    expect(finished(events, 'carjack')).toHaveLength(1);
    expect(finishedSnap(events, 'carjack').drops[ITEM]).toBe(2);
    expect(reg().seasonalsSize()).toBe(0);
    expect(reg().session?.snapshot().drops[ITEM]).toBeUndefined();

    events.length = 0;
    adv(60_000);
    line(log.s11End);
    line(log.s11Wave);
    expect(events).toEqual([]);

    bag(1);                                            // the fresh run credits the map only
    expect(reg().map?.snapshot().drops[ITEM]).toBe(1);
    expect(reg().session?.snapshot().drops[ITEM]).toBe(1);
    expect(reg().session?.snapshot().dropsBySource?.map?.[ITEM]).toBe(1);
  });

  it('on a dormant tracker: a later marker cannot wake the torn-down run, and a new encounter starts clean', () => {
    const {events, e, line, adv, reg} = setup();
    line(log.afterlightStart);
    adv(5_100);
    const stale = reg().seasonal('afterlight')!;
    e.reset(TEST_IDENTITY);
    events.length = 0;
    line(log.afterlightEnd);
    stale.resetLootTimer();
    expect(events).toEqual([]);

    line(log.afterlightStart);
    expect(started(events, 'afterlight')).toHaveLength(1);
    expect(reg().seasonal('afterlight')).not.toBe(stale);
  });

  it('while paused with a woken window frozen in flight: reset kills it, the resume afterwards fires nothing', () => {
    const {events, e, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);
    bag(1);
    adv(1_000);
    e.pause();

    events.length = 0;
    e.reset(TEST_IDENTITY);
    expect(finished(events, 'carjack')).toHaveLength(1);
    expect(reg().seasonalsSize()).toBe(0);

    events.length = 0;
    e.resume();
    adv(120_000);
    expect(events.filter(ev => ev.type === 'tracker_finished' || ev.type === 'loot_window_started'
      || ev.type === 'loot_window_ended')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Bubble start (Sandlord hub)
// ---------------------------------------------------------------------------

describe('Sandlord hub bubble evicts an in-map tracker', () => {
  it('dormant carjack: finished once by the bubble; a late Stop does nothing', () => {
    const {events, line, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    const stale = reg().seasonal('carjack')!;

    line(log.zoneTransition(MAP, SANDLORD_HUB));
    expect(reg().seasonal('carjack')).toBeNull();
    expect(reg().seasonal('sandlord')?.phase).toBe('hub');
    expect(finished(events, 'carjack')).toHaveLength(1);

    events.length = 0;
    line(log.s11End);
    line(log.s11Wave);
    stale.armLootTimer();
    stale.resetLootTimer();
    adv(60_000);
    expect(events.filter(ev => ev.type === 'loot_window_started' || ev.type === 'tracker_started'
      || ev.type === 'tracker_finished')).toEqual([]);
    expect(stale.active).toBe(false);
    expect(reg().seasonal('carjack')).toBeNull();
  });

  it('a woken carjack mid terminal window: evicted with its credit, the timer dies with it', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);
    bag(3);
    line(log.zoneTransition(MAP, SANDLORD_HUB));
    expect(finished(events, 'carjack')).toHaveLength(1);
    expect(finishedSnap(events, 'carjack').drops[ITEM]).toBe(3);

    events.length = 0;
    adv(60_000);
    expect(events.filter(ev => ev.type === 'tracker_finished' || ev.type === 'loot_window_ended')).toEqual([]);
    expect(reg().seasonal('sandlord')?.phase).toBe('hub');
  });

  it('dormant afterlight and lunaria: a late End / strum cannot revive them inside the bubble', () => {
    const {events, line, adv, reg} = setup();
    line(log.afterlightStart);
    line(log.s14Strum);
    adv(5_100);
    line(log.zoneTransition(MAP, SANDLORD_HUB));
    expect(reg().seasonal('afterlight')).toBeNull();
    expect(reg().seasonal('lunaria')).toBeNull();

    events.length = 0;
    line(log.afterlightEnd);
    line(log.s14Strum);
    expect(events.filter(ev => ev.type === 'loot_window_started' || ev.type === 'tracker_started')).toEqual([]);
  });

  it('dormant sandlord TILE run: retired for the hub bubble; a late quench neither wakes it nor touches the bubble', () => {
    const {events, line, adv, reg} = setup();
    line(log.s10Wave);
    adv(10_100);
    const tile = reg().seasonal('sandlord')!;
    expect(tile.phase).toBe('map');

    line(log.zoneTransition(MAP, SANDLORD_HUB));
    const hub = reg().seasonal('sandlord')!;
    expect(hub).not.toBe(tile);
    expect(hub.phase).toBe('hub');
    expect(finished(events, 'sandlord')).toHaveLength(1);

    events.length = 0;
    line(log.s10Quench);
    line(log.s10Wave);
    tile.armLootTimer();
    tile.resetLootTimer();
    adv(60_000);
    expect(events.filter(ev => ev.type === 'loot_window_started' || ev.type === 'tracker_finished')).toEqual([]);
    expect(reg().seasonal('sandlord')).toBe(hub);
    expect(hub.active).toBe(true);
    expect(hub.isLootCollecting()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Ownership
// ---------------------------------------------------------------------------

describe('ownership follows the latest wake', () => {
  it('two dormant seasonals woken in sequence: the later wake owns, and ownership falls back when it finishes', () => {
    const {events, e, line, bag, adv, reg} = setup();
    e.setCarjackLootDurationMs(20_000);
    line(log.s11Start);                                // carjack first
    line(log.afterlightStart);                         // afterlight second (newest)
    adv(20_100);                                       // both parked
    expect(reg().seasonal('carjack')?.active).toBe(false);
    expect(reg().seasonal('afterlight')?.active).toBe(false);

    line(log.s11End);
    expect(reg().writer()).toBe('carjack');
    adv(1_000);
    line(log.afterlightEnd);
    expect(reg().writer()).toBe('afterlight');
    expect(lastOwner(events, 'afterlight')).toBe(true);
    expect(lastOwner(events, 'carjack')).toBe(false);

    bag(2);
    expect(reg().seasonal('afterlight')?.snapshot().drops[ITEM]).toBe(2);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBeUndefined();

    adv(5_100);                                        // afterlight finishes
    expect(reg().seasonal('afterlight')).toBeNull();
    expect(reg().writer()).toBe('carjack');
    expect(lastOwner(events, 'carjack')).toBe(true);
    bag(1);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBe(1);
    expect(reg().session?.snapshot().dropsBySource?.afterlight?.[ITEM]).toBe(2);
    expect(reg().session?.snapshot().dropsBySource?.carjack?.[ITEM]).toBe(1);
  });

  it('woken in the opposite order: the carjack wake is the newest and owns', () => {
    const {e, line, bag, adv, reg} = setup();
    e.setCarjackLootDurationMs(20_000);
    line(log.s11Start);
    line(log.afterlightStart);
    adv(20_100);

    line(log.afterlightEnd);
    expect(reg().writer()).toBe('afterlight');
    adv(1_000);
    line(log.s11End);
    expect(reg().writer()).toBe('carjack');
    bag(2);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBe(2);
    expect(reg().seasonal('afterlight')?.snapshot().drops[ITEM]).toBeUndefined();
  });

  it('a wake while a later-started, still-active seasonal runs: the woken one owns until it finishes', () => {
    const {events, e, line, bag, adv, reg} = setup();
    e.setLunariaLootDurationMs(30_000);
    line(log.afterlightStart);
    adv(5_100);                                        // afterlight dormant
    line(log.s14Strum);                                // lunaria started later, active, owner
    expect(reg().writer()).toBe('lunaria');

    adv(500);
    line(log.afterlightEnd);
    expect(reg().writer()).toBe('afterlight');
    expect(lastOwner(events, 'lunaria')).toBe(false);
    bag(2);
    expect(reg().seasonal('afterlight')?.snapshot().drops[ITEM]).toBe(2);
    expect(reg().seasonal('lunaria')?.snapshot().drops[ITEM]).toBeUndefined();

    adv(5_100);
    expect(reg().seasonal('afterlight')).toBeNull();
    expect(reg().writer()).toBe('lunaria');
    bag(1);
    expect(reg().seasonal('lunaria')?.snapshot().drops[ITEM]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Clockwork sequences
// ---------------------------------------------------------------------------

describe('clockwork: podium -> cogwheel -> cogwheel_end -> turn-in', () => {
  it('full run: fights stay the map\'s, the turn-in claims, a late cogwheel_end / cogwheel is ignored, one window', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s7Podium);
    line(log.s7Cogwheel);
    bag(1);                                            // fight-phase drop: the map's
    expect(reg().seasonal('clockwork')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(reg().writer()).toBe('map');
    adv(1_000);
    line(log.s7CogwheelEnd);
    expect(reg().seasonal('clockwork')?.active).toBe(false);
    adv(3_000);
    line(log.s7Cogwheel);                              // second cogwheel
    adv(500);
    line(log.s7Turnin);                                // while the second is still spinning
    expect(reg().writer()).toBe('clockwork');
    const windowsAtTurnin = windows(events, 'clockwork').length;

    bag(4);
    line(log.s7CogwheelEnd);                           // bonus cogwheel in the reward burst: ignored
    line(log.s7Cogwheel);
    line(log.s7Turnin);                                // repeat turn-in: ignored
    expect(reg().seasonal('clockwork')?.active).toBe(true);
    expect(windows(events, 'clockwork')).toHaveLength(windowsAtTurnin);

    adv(5_100);                                        // the 5s loot window, not the 10s cogwheel timeout
    expect(reg().seasonal('clockwork')).toBeNull();
    expect(started(events, 'clockwork')).toHaveLength(1);
    expect(finished(events, 'clockwork')).toHaveLength(1);
    expect(finishedSnap(events, 'clockwork').drops[ITEM]).toBe(4);
    expect(reg().map?.snapshot().drops[ITEM]).toBe(5);
  });

  it('turn-in replaces the in-flight 10s cogwheel timeout with the 5s loot window', () => {
    const {events, line, adv, reg} = setup();
    line(log.s7Podium);
    line(log.s7Cogwheel);                              // 10s timeout in flight
    adv(2_000);
    line(log.s7Turnin);
    adv(4_900);
    expect(reg().seasonal('clockwork')?.active).toBe(true);
    adv(200);
    expect(reg().seasonal('clockwork')).toBeNull();
    expect(finished(events, 'clockwork')).toHaveLength(1);
  });

  it('turn-in after the cogwheel timeout parked it (10s abandonment) still wakes, claims and credits', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s7Podium);
    line(log.s7Cogwheel);
    adv(10_000);                                       // exactly the timeout: parks
    expect(reg().seasonal('clockwork')?.active).toBe(false);
    expect(reg().seasonal('clockwork')?.isLootCollecting()).toBe(false);

    line(log.s7Turnin);
    expect(reg().seasonal('clockwork')?.active).toBe(true);
    bag(3);
    expect(reg().seasonal('clockwork')?.snapshot().drops[ITEM]).toBe(3);
    adv(5_100);
    expect(finished(events, 'clockwork')).toHaveLength(1);
    expect(finishedSnap(events, 'clockwork').drops[ITEM]).toBe(3);
  });

  it('cogwheel_end on a dormant tracker is a no-op (nothing published)', () => {
    const {events, line, reg} = setup();
    line(log.s7Podium);
    events.length = 0;
    line(log.s7CogwheelEnd);
    expect(events).toEqual([]);
    expect(reg().seasonal('clockwork')?.active).toBe(false);
  });

  it('turn-in while the session is paused is swallowed whole: nothing claimed, woken or armed, even after the resume', () => {
    const {events, e, line, bag, adv, reg} = setup();
    line(log.s7Podium);
    line(log.s7Cogwheel);
    adv(1_000);
    e.pause();
    line(log.s7Turnin);
    bag(3);
    e.resume();
    events.length = 0;                                 // the resume republishes the frozen cogwheel window
    adv(120_000);                                      // ...which then lapses: parked

    const t = reg().seasonal('clockwork')!;
    expect(t.claimsDrops).toBe(false);
    expect(reg().writer()).toBe('map');
    expect(windows(events, 'clockwork').filter(w => w.type === 'loot_window_started')).toHaveLength(0);
    expect(finished(events, 'clockwork')).toHaveLength(0);

    // The pause left no latch: the real turn-in (a repeat) after the resume still works.
    line(log.s7Turnin);
    expect(t.claimsDrops).toBe(true);
    expect(t.active).toBe(true);
    bag(2);
    expect(t.snapshot().drops[ITEM]).toBe(2);
    adv(5_100);
    expect(finished(events, 'clockwork')).toHaveLength(1);
  });

  it('turn-in on the greyed-out podium tracker while paused leaves it dormant through town entry', () => {
    const {events, e, line, reg} = setup();
    line(log.s7Podium);
    e.pause();
    line(log.s7Turnin);
    e.resume();
    expect(reg().seasonal('clockwork')?.active).toBe(false);
    line(log.zoneTransition(MAP, TOWN));
    expect(finished(events, 'clockwork')).toHaveLength(1);
    expect(finishedSnap(events, 'clockwork').drops).toEqual({});
  });

  it('a second podium after the run finished starts a fresh tracker', () => {
    const {events, line, adv, reg} = setup();
    line(log.s7Podium);
    line(log.s7Turnin);
    adv(5_100);
    expect(reg().seasonal('clockwork')).toBeNull();
    line(log.s7Podium);
    expect(started(events, 'clockwork')).toHaveLength(2);
    expect(reg().seasonal('clockwork')?.active).toBe(false);
    expect(reg().seasonal('clockwork')?.claimsDrops).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Lunaria strum burst
// ---------------------------------------------------------------------------

describe('lunaria strum burst', () => {
  it('40 strums in 1s on a dormant run: one wake, no flicker, every strum re-arms, the window ends 5s after the last', () => {
    const {events, line, adv, reg} = setup();
    line(log.s14Strum);
    adv(5_100);
    expect(reg().seasonal('lunaria')?.active).toBe(false);

    events.length = 0;
    for (let i = 0; i < 40; i++) { line(log.s14Strum); adv(25); }
    expect(reg().seasonal('lunaria')?.active).toBe(true);
    expect(windows(events, 'lunaria')).toHaveLength(40);
    expect(started(events, 'lunaria')).toHaveLength(0);
    expect(updates(events, 'lunaria').filter(u => u.type === 'tracker_update' && !u.tracker.active)).toHaveLength(0);
    expect(updates(events, 'lunaria').filter(u => u.type === 'tracker_update' && u.tracker.active).length).toBeGreaterThanOrEqual(1);

    adv(4_900);                                        // 25ms since last strum + 4900 -> still inside
    expect(reg().seasonal('lunaria')?.active).toBe(true);
    adv(200);
    expect(reg().seasonal('lunaria')?.active).toBe(false);
    expect(finished(events, 'lunaria')).toHaveLength(0);
  });

  it('a strum after a decayed pickup refresh restores the full window', () => {
    const {line, bag, adv, reg} = setup();
    line(log.s14Strum);
    adv(4_500);
    bag(1);                                            // refresh: re-arms to 4s
    line(log.s14Strum);                                // full 5s again
    adv(4_900);
    expect(reg().seasonal('lunaria')?.active).toBe(true);
    adv(200);
    expect(reg().seasonal('lunaria')?.active).toBe(false);
  });

  it('a strum burst while the session is paused never wakes the parked run', () => {
    const {events, e, line, adv, reg} = setup();
    line(log.s14Strum);
    adv(5_100);
    e.pause();
    events.length = 0;
    for (let i = 0; i < 10; i++) line(log.s14Strum);
    e.resume();
    expect(reg().seasonal('lunaria')?.active).toBe(false);
    expect(events.filter(ev => ev.type === 'loot_window_started')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Sandlord quench / wave interplay
// ---------------------------------------------------------------------------

describe('sandlord tile: quench -> wave inside 1s -> quench again', () => {
  it('dormant start: wave wakes (stamping the throttle), quench, throttled wave, quench: the window finishes the run and credits it all', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s10Wave);
    adv(10_100);                                       // dormant
    line(log.s10Wave);                                 // dormant bypass: wake + arm, stamps
    expect(reg().seasonal('sandlord')?.active).toBe(true);
    bag(1);
    adv(300);
    line(log.s10Quench);                               // terminal window
    adv(300);
    line(log.s10Wave);                                 // 600ms after the stamp: swallowed, flag stays terminal
    bag(1);
    adv(300);
    line(log.s10Quench);                               // quench again: re-arm terminal
    bag(1);

    adv(10_100);
    expect(reg().seasonal('sandlord')).toBeNull();
    expect(finished(events, 'sandlord')).toHaveLength(1);
    expect(started(events, 'sandlord')).toHaveLength(1);
    expect(finishedSnap(events, 'sandlord').drops[ITEM]).toBe(3);
  });

  it('a wave at exactly 1000ms after the stamp is NOT swallowed: it re-arms and flips the window back to park', () => {
    const {events, line, adv, reg} = setup();
    line(log.s10Wave);
    adv(10_100);
    line(log.s10Wave);                                 // wake, stamp T
    adv(200);
    line(log.s10Quench);                               // terminal
    adv(799);
    line(log.s10Wave);                                 // 999ms: swallowed
    expect(windows(events, 'sandlord')).toHaveLength(2 + 1 + 1 - 0 + 0 === 4 ? windows(events, 'sandlord').length : 0);
    const before = windows(events, 'sandlord').length;
    adv(1);
    line(log.s10Wave);                                 // exactly 1000ms: re-arms, park again
    expect(windows(events, 'sandlord')).toHaveLength(before + 1);

    adv(10_100);
    expect(reg().seasonal('sandlord')?.active).toBe(false);     // parked, not finished
    expect(finished(events, 'sandlord')).toHaveLength(0);
  });

  it('the 999ms wave leaves the terminal window untouched: finishes on the quench\'s own schedule', () => {
    const {events, line, adv, reg} = setup();
    line(log.s10Wave);
    adv(10_100);
    line(log.s10Wave);                                 // stamp T
    adv(100);
    line(log.s10Quench);                               // terminal window, deadline T+100+10000
    adv(899);
    line(log.s10Wave);                                 // T+999: swallowed
    adv(9_100);                                        // T+10_099
    expect(finished(events, 'sandlord')).toHaveLength(0);
    adv(2);                                            // T+10_101 > quench deadline
    expect(reg().seasonal('sandlord')).toBeNull();
    expect(finished(events, 'sandlord')).toHaveLength(1);
  });

  it('eight quenches inside one encounter (real-log pattern) still end with one finish', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s10Wave);
    for (let i = 0; i < 8; i++) { adv(1_500); line(log.s10Quench); bag(1); }
    expect(started(events, 'sandlord')).toHaveLength(1);
    adv(10_100);
    expect(reg().seasonal('sandlord')).toBeNull();
    expect(finished(events, 'sandlord')).toHaveLength(1);
    expect(finishedSnap(events, 'sandlord').drops[ITEM]).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 9. resetLootTimerThrottled timing edges
// ---------------------------------------------------------------------------

describe('resetLootTimerThrottled timing edges (carjack waves through the chain)', () => {
  it('active: 999ms is swallowed, exactly 1000ms re-arms', () => {
    const {events, line, adv} = setup();
    line(log.s11Start);                                // unstamped arm
    adv(2_000);
    line(log.s11Wave);                                 // stamps
    const n = windows(events, 'carjack').length;
    adv(999);
    line(log.s11Wave);
    expect(windows(events, 'carjack')).toHaveLength(n);
    adv(1);
    line(log.s11Wave);                                 // exactly 1000ms
    expect(windows(events, 'carjack')).toHaveLength(n + 1);
  });

  it('wake then an immediate wave: the dormant wave wakes and stamps, the immediate one is swallowed, 1000ms later it re-arms', () => {
    const {events, line, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    const n = windows(events, 'carjack').length;

    line(log.s11Wave);                                 // wake + arm
    expect(reg().seasonal('carjack')?.active).toBe(true);
    expect(windows(events, 'carjack')).toHaveLength(n + 1);
    line(log.s11Wave);                                 // same ms: swallowed
    expect(windows(events, 'carjack')).toHaveLength(n + 1);
    adv(999);
    line(log.s11Wave);
    expect(windows(events, 'carjack')).toHaveLength(n + 1);
    adv(1);
    line(log.s11Wave);
    expect(windows(events, 'carjack')).toHaveLength(n + 2);
  });

  it('a dormant wave inside 1s of the previous wake stamp still wakes (bypass), and then stamps afresh', () => {
    const {events, e, line, adv, reg} = setup();
    e.setCarjackLootDurationMs(300);
    line(log.s11Start);
    adv(400);                                          // parked
    line(log.s11Wave);                                 // wake, stamp T
    adv(350);                                          // window lapses: parked again, T+350
    expect(reg().seasonal('carjack')?.active).toBe(false);
    const n = windows(events, 'carjack').length;

    line(log.s11Wave);                                 // dormant: bypass although only 350ms after the stamp
    expect(reg().seasonal('carjack')?.active).toBe(true);
    expect(windows(events, 'carjack')).toHaveLength(n + 1);
    line(log.s11Wave);                                 // now active, inside 1s of the NEW stamp: swallowed
    expect(windows(events, 'carjack')).toHaveLength(n + 1);
  });

  it('a Stop between wake-wave and next wave does not stamp: the wave after 1s re-arms the terminal window, still terminal', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11Wave);                                 // wake, stamp T
    adv(500);
    line(log.s11End);                                  // terminal arm at T+500
    adv(500);
    bag(1);
    line(log.s11Wave);                                 // T+1000: re-arms the terminal window (full 5s)
    adv(4_900);
    expect(reg().seasonal('carjack')?.active).toBe(true);
    adv(200);
    expect(reg().seasonal('carjack')).toBeNull();      // still finishes, not parked
    expect(finishedSnap(events, 'carjack').drops[ITEM]).toBe(1);
  });

  it('registry level: wake, park and wake again in the same millisecond - every dormant call arms, the active one is swallowed', () => {
    const events: EngineEvent[] = [];
    const emit = internalEmit(ev => { events.push(ev); });
    const r = new TrackerRegistry();
    r.startSession();
    r.startMap();
    const t = r.startSeasonal({type: 'carjack', lootDurationMs: 5_000, pauseOnLootExpiry: true}, emit)!;
    t.pauseTracker();
    events.length = 0;

    expect(t.resetLootTimerThrottled()).toBe(true);    // dormant bypass
    t.pauseTracker();
    expect(t.resetLootTimerThrottled()).toBe(true);    // dormant again, same ms: bypass again
    expect(t.resetLootTimerThrottled()).toBe(false);   // active, same ms: throttled
    expect(windows(events, 'carjack')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 10. Afterlight Special burst -> wave -> end
// ---------------------------------------------------------------------------

describe('afterlight: Special burst -> wave -> end', () => {
  it('one wake for the burst, the wave moves the window, the end turns it terminal, everything credits and the run finishes once', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.afterlightStart);
    adv(5_100);                                        // dormant
    events.length = 0;

    line(log.afterlightSpecialStart);                  // wake
    bag(1);
    adv(300); line(log.afterlightSpecialStart);
    adv(300); line(log.afterlightSpecialStart);
    adv(100); line(log.afterlightWave);                // stamps (never stamped before): re-arms
    bag(1);
    adv(300); line(log.afterlightWave);                // 300ms: swallowed
    expect(windows(events, 'afterlight')).toHaveLength(4);
    adv(100); line(log.afterlightSpecialEnd);          // BGM Stop = afterlight_end: terminal arm
    expect(windows(events, 'afterlight')).toHaveLength(5);
    bag(1);

    line(log.afterlightSpecialEnd);                    // repeat: de-duped
    line(log.afterlightLose);                          // another end marker: de-duped
    expect(windows(events, 'afterlight')).toHaveLength(5);

    expect(updates(events, 'afterlight').filter(u => u.type === 'tracker_update' && !u.tracker.active)).toHaveLength(0);
    expect(started(events, 'afterlight')).toHaveLength(0);

    adv(1_000);
    line(log.afterlightWave);                          // late spawn after the end: re-arms the terminal window
    expect(windows(events, 'afterlight')).toHaveLength(6);
    adv(4_900);
    expect(reg().seasonal('afterlight')?.active).toBe(true);
    adv(200);
    expect(reg().seasonal('afterlight')).toBeNull();
    expect(finished(events, 'afterlight')).toHaveLength(1);
    expect(finishedSnap(events, 'afterlight').drops[ITEM]).toBe(3);
  });

  it('a Special marker after the end re-arms the window but it stays terminal (finishes, no re-park)', () => {
    const {events, line, adv, reg} = setup();
    line(log.afterlightStart);
    line(log.afterlightEnd);
    adv(2_000);
    line(log.afterlightSpecialStart);
    adv(4_900);
    expect(reg().seasonal('afterlight')?.active).toBe(true);
    adv(200);
    expect(reg().seasonal('afterlight')).toBeNull();
    expect(finished(events, 'afterlight')).toHaveLength(1);
  });

  it('a folded second encounter after the end clears the terminal flag: its lull parks instead of finishing', () => {
    const {events, line, adv, reg} = setup();
    line(log.afterlightStart);
    adv(5_100);
    line(log.afterlightEnd);                           // wake, terminal
    line(log.afterlightStart);                         // second encounter folds into the same tracker before the window ends
    adv(5_100);
    expect(finished(events, 'afterlight')).toHaveLength(0);
    expect(reg().seasonal('afterlight')?.active).toBe(false);
    line(log.afterlightEnd);                           // and can end properly again
    expect(reg().seasonal('afterlight')?.active).toBe(true);
    adv(5_100);
    expect(finished(events, 'afterlight')).toHaveLength(1);
    expect(started(events, 'afterlight')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Carjack double Stop around a dormancy
// ---------------------------------------------------------------------------

describe('carjack: double Stop around a dormancy', () => {
  it('Stop, dormant-free: the second Stop inside the window is a no-op', () => {
    const {events, line, adv, reg} = setup();
    line(log.s11Start);
    line(log.s11End);
    const n = windows(events, 'carjack').length;
    adv(2_000);
    line(log.s11End);
    expect(windows(events, 'carjack')).toHaveLength(n);
    adv(3_100);
    expect(reg().seasonal('carjack')).toBeNull();
  });

  it('dormant -> Stop wakes -> second Stop 6s later (after the finish) does nothing and does not resurrect', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);
    bag(2);
    adv(6_000);
    expect(reg().seasonal('carjack')).toBeNull();

    events.length = 0;
    line(log.s11End);
    adv(10_000);
    expect(events).toEqual([]);
  });

  it('first Stop swallowed by a pause on a dormant run, second Stop after the resume wakes and finishes it', () => {
    const {events, e, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    e.pause();
    line(log.s11End);                                  // lost to the pause
    e.resume();
    expect(reg().seasonal('carjack')?.active).toBe(false);

    line(log.s11End);                                  // the second Stop of the pair
    expect(reg().seasonal('carjack')?.active).toBe(true);
    bag(2);
    adv(5_100);
    expect(reg().seasonal('carjack')).toBeNull();
    expect(finishedSnap(events, 'carjack').drops[ITEM]).toBe(2);
  });

  it('the pair straddles a dormancy-and-wake: Stop1 on an active run, run parks via wave lull? no - terminal windows never park', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    line(log.s11End);                                  // terminal window 5s
    bag(1);
    adv(4_000);
    line(log.s11End);                                  // second Stop inside the window
    adv(1_100);                                        // original deadline passes: finishes (no re-arm by the Stop)
    expect(reg().seasonal('carjack')).toBeNull();
    expect(finishedSnap(events, 'carjack').drops[ITEM]).toBe(1);
  });

  it('a fresh encounter after a finished one: start resets the terminal latch, so its Stop works again', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    line(log.s11End);
    adv(5_100);
    expect(finished(events, 'carjack')).toHaveLength(1);

    line(log.s11Start);
    adv(5_100);                                        // dormant
    line(log.s11End);
    expect(reg().seasonal('carjack')?.active).toBe(true);
    bag(2);
    adv(5_100);
    expect(finished(events, 'carjack')).toHaveLength(2);
    expect(started(events, 'carjack')).toHaveLength(2);
    expect(finishedSnap(events, 'carjack').drops[ITEM]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. Pickups keep refreshing a woken terminal window, which still finishes
// ---------------------------------------------------------------------------

describe('a woken terminal window refreshed by pickups still finishes', () => {
  it('carjack: 30 pickups every 400ms keep it alive and credited, then it finishes within the 1s floor', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);
    for (let i = 0; i < 30; i++) { bag(1); adv(400); }
    expect(reg().seasonal('carjack')?.active).toBe(true);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBe(30);

    adv(1_100);                                        // no more pickups: floor window lapses
    expect(reg().seasonal('carjack')).toBeNull();
    expect(finished(events, 'carjack')).toHaveLength(1);
    expect(finishedSnap(events, 'carjack').drops[ITEM]).toBe(30);
  });

  it('clockwork: the same after a turn-in on the dormant podium tracker', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s7Podium);
    line(log.s7Turnin);
    for (let i = 0; i < 30; i++) { bag(1); adv(400); }
    expect(reg().seasonal('clockwork')?.active).toBe(true);

    adv(1_100);
    expect(reg().seasonal('clockwork')).toBeNull();
    expect(finishedSnap(events, 'clockwork').drops[ITEM]).toBe(30);
    expect(finished(events, 'clockwork')).toHaveLength(1);
  });

  it('a pickup after the window ended does not revive the finished run', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);
    line(log.s11End);
    adv(5_100);
    expect(reg().seasonal('carjack')).toBeNull();
    events.length = 0;
    bag(2);
    expect(updates(events, 'carjack')).toEqual([]);
    expect(windows(events, 'carjack')).toEqual([]);
    expect(reg().seasonalsSize()).toBe(0);
  });

  it('a pickup storm after a wake never extends a PARKED wave window: parks on schedule', () => {
    const {line, bag, adv, reg} = setup();
    line(log.s11Start);                                // wave-type window, not terminal
    for (let i = 0; i < 10; i++) { adv(400); bag(1); }
    expect(reg().seasonal('carjack')?.active).toBe(true);
    adv(1_100);                                        // 5000ms since the start: parked despite the pickups
    expect(reg().seasonal('carjack')?.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. An in-map window that finishes while the player is in an Arcana fight
// ---------------------------------------------------------------------------

// In-map markers never arrive outside their map, so there is no cross-zone gate.
function enterArcanaFight(h: ReturnType<typeof setup>) {
  h.line(log.s9Minigame);
  h.line(log.zoneTransition(MAP, ARCANA_FIGHT));
  expect(ctx(h.e).location).toBe('seasonal-scene');
  expect(h.reg().map?.active).toBe(false);             // frozen by the interlude
  expect(h.reg().seasonal('arcana')?.active).toBe(true);
  expect(h.reg().writer()).toBe('arcana');
}

describe('a window armed in the map finishes inside an Arcana fight scene', () => {
  it('the in-map mechanic finishes inside the fight scene and Arcana owns the loot again', () => {
    const h = setup();
    h.line(log.s11Start);
    h.adv(5_100);
    h.line(log.s11End);                                // in the map: wake, terminal window
    h.bag(2);
    enterArcanaFight(h);
    h.adv(5_100);
    expect(h.reg().seasonal('carjack')).toBeNull();
    expect(finishedSnap(h.events, 'carjack').drops[ITEM]).toBe(2);
    expect(h.reg().writer()).toBe('arcana');
    h.bag(1);
    expect(h.reg().seasonal('arcana')?.snapshot().drops[ITEM]).toBe(1);
  });
});
