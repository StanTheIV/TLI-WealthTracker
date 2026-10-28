/**
 * Step 1.4 — a loot window armed on a dormant (self-parked) tracker WAKES it.
 *
 * Before 1.4 the terminal markers (sandlord quench, afterlight end/special,
 * carjack Stop) armed a window on a parked tracker without waking it: the
 * window was "live" but every drop was rejected and expiry finished the run
 * with nothing credited. The rule now lives in one place —
 * `TrackerRegistry.wakeForLoot` — which also holds the pause rule: while the
 * SESSION is paused an arm/reset/wake is a no-op. `refreshLootTimer` never wakes.
 *
 * `wakeForLoot` does not exist until 1.4 lands, so the registry-level cases
 * reach it through a cast. Mechanic flows run the production chain.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent, SeasonalType} from '@/shared/contracts/engine';
import {TrackerRegistry} from '@/main/engine/tracker-registry';
import type {SeasonalTracker} from '@/main/engine/seasonal-tracker';
import {boot, createDispatcher, createEngine, ctx, feed, internalEmit, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const ITEM = 1000;

// ---------------------------------------------------------------------------
// Production-chain helpers
// ---------------------------------------------------------------------------

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 0}]);
  feed(d, e, log.zoneTransition(TOWN, MAP));
  let total = 0;
  const line = (l: string) => feed(d, e, l);
  /** Pick up `n` more of ITEM (the bag line carries the running total). */
  const bag  = (n: number) => { total += n; line(log.bagUpdate(1, ITEM, total)); };
  const adv  = (ms: number) => vi.advanceTimersByTime(ms);
  const reg  = () => ctx(e).registry;
  return {events, d, e, line, bag, adv, reg};
}

const ofType = (events: EngineEvent[], type: SeasonalType) => ({
  started:  events.filter(ev => ev.type === 'tracker_started'  && ev.tracker.seasonalType === type),
  finished: events.filter(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === type),
  windows:  events.filter(ev => ev.type === 'loot_window_started' && ev.seasonalType === type),
});

function finishedDrops(events: EngineEvent[], type: SeasonalType): Record<number, number> | undefined {
  const f = events.find(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === type);
  return f && f.type === 'tracker_finished' ? f.tracker.drops : undefined;
}

/** Credited to the seasonal AND the map AND the session, single-owner in the by-source split. */
function expectCredited(
  r: TrackerRegistry, type: SeasonalType, qty: number,
): void {
  expect(r.seasonal(type)?.snapshot().drops[ITEM]).toBe(qty);
  expect(r.map?.snapshot().drops[ITEM]).toBe(qty);
  expect(r.session?.snapshot().drops[ITEM]).toBe(qty);
  const dbs = r.session!.snapshot().dropsBySource!;
  expect(dbs[type]?.[ITEM]).toBe(qty);
  expect(dbs.map?.[ITEM]).toBeUndefined();
}

// ---------------------------------------------------------------------------
// Sandlord in-map tile
// ---------------------------------------------------------------------------

describe('sandlord tile: quench on a dormant tracker', () => {
  it('wakes it — the terminal window credits the run and its expiry finishes it', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s10Wave);
    adv(10_100);                                   // wave window lapses: parked dormant
    expect(reg().seasonal('sandlord')?.active).toBe(false);

    events.length = 0;
    line(log.s10Quench);
    expect(reg().seasonal('sandlord')?.active).toBe(true);
    expect(reg().seasonal('sandlord')?.isLootCollecting()).toBe(true);
    expect(ofType(events, 'sandlord').windows).toHaveLength(1);

    bag(3);
    expectCredited(reg(), 'sandlord', 3);

    adv(10_100);                                   // terminal window: finish, not park
    expect(reg().seasonal('sandlord')).toBeNull();
    const t = ofType(events, 'sandlord');
    expect(t.started).toHaveLength(0);             // same tracker, never restarted
    expect(t.finished).toHaveLength(1);
    expect(finishedDrops(events, 'sandlord')?.[ITEM]).toBe(3);
  });

  it('the wake publishes the active, owning row before the window', () => {
    const {events, line, adv} = setup();
    line(log.s10Wave);
    adv(10_100);

    events.length = 0;
    line(log.s10Quench);
    const relevant = events.filter(ev =>
      (ev.type === 'tracker_update' && ev.tracker.seasonalType === 'sandlord')
      || (ev.type === 'loot_window_started' && ev.seasonalType === 'sandlord'));
    const first = relevant[0];
    expect(first.type).toBe('tracker_update');
    if (first.type === 'tracker_update') {
      expect(first.tracker.active).toBe(true);
      expect(first.tracker.owner).toBe(true);
    }
    expect(relevant.some(ev => ev.type === 'loot_window_started')).toBe(true);
  });

  it('a woken tracker becomes the writer — not a seasonal started while it was dormant', () => {
    const {line, bag, adv, reg} = setup();
    line(log.s10Wave);
    adv(10_100);                                   // sandlord dormant
    line(log.s11Start);                            // carjack starts later: active owner
    expect(reg().writer()).toBe('carjack');

    adv(500);
    line(log.s10Quench);                           // wakes sandlord, re-arms its window
    expect(reg().writer()).toBe('sandlord');

    bag(3);
    expect(reg().seasonal('sandlord')?.snapshot().drops[ITEM]).toBe(3);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(reg().map?.snapshot().drops[ITEM]).toBe(3);
    expect(reg().session?.snapshot().drops[ITEM]).toBe(3);
  });

  it('quench then a wave inside the 1s throttle: the window still finishes the run on expiry', () => {
    const {events, line, adv, reg} = setup();
    line(log.s10Wave);                             // start
    adv(2_000);
    line(log.s10Wave);                             // reset, stamps the throttle
    line(log.s10Quench);                           // terminal window in flight
    adv(200);
    line(log.s10Wave);                             // swallowed by the throttle: must NOT flip the window to park

    adv(10_100);
    expect(reg().seasonal('sandlord')).toBeNull();
    expect(ofType(events, 'sandlord').finished).toHaveLength(1);
  });

  it('while the session is paused the quench credits nothing and arms nothing; resume leaves it dormant', () => {
    const {events, e, line, bag, adv, reg} = setup();
    line(log.s10Wave);
    adv(10_100);

    e.pause();
    events.length = 0;
    line(log.s10Quench);
    bag(3);
    expect(reg().seasonal('sandlord')?.active).toBe(false);
    expect(reg().seasonal('sandlord')?.isLootCollecting()).toBe(false);
    expect(reg().seasonal('sandlord')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(ofType(events, 'sandlord').windows).toHaveLength(0);

    e.resume();
    expect(reg().seasonal('sandlord')?.active).toBe(false);
    bag(1);
    expect(reg().seasonal('sandlord')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(ofType(events, 'sandlord').windows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Afterlight
// ---------------------------------------------------------------------------

describe('afterlight: terminal and Special markers on a dormant tracker', () => {
  it('Special variant: the BGM Stop wakes the dormant run — credited, then finishes', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.afterlightSpecialStart);
    line(log.afterlightStart);
    adv(5_100);                                    // spawn lull: parked
    expect(reg().seasonal('afterlight')?.active).toBe(false);

    events.length = 0;
    line(log.afterlightSpecialEnd);
    expect(reg().seasonal('afterlight')?.active).toBe(true);
    expect(ofType(events, 'afterlight').windows).toHaveLength(1);

    bag(3);
    expectCredited(reg(), 'afterlight', 3);

    adv(5_100);
    expect(reg().seasonal('afterlight')).toBeNull();
    const t = ofType(events, 'afterlight');
    expect(t.started).toHaveLength(0);
    expect(t.finished).toHaveLength(1);
    expect(finishedDrops(events, 'afterlight')?.[ITEM]).toBe(3);
  });

  it('a Lose marker on a dormant run wakes it — credited, then finishes', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.afterlightStart);
    adv(5_100);
    expect(reg().seasonal('afterlight')?.active).toBe(false);

    line(log.afterlightLose);
    expect(reg().seasonal('afterlight')?.active).toBe(true);
    bag(2);
    expectCredited(reg(), 'afterlight', 2);

    adv(5_100);
    expect(reg().seasonal('afterlight')).toBeNull();
    expect(ofType(events, 'afterlight').started).toHaveLength(1);
    expect(finishedDrops(events, 'afterlight')?.[ITEM]).toBe(2);
  });

  it('afterlight_special on a dormant run wakes it, credits, then re-parks; a later end finishes it', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.afterlightStart);
    adv(5_100);
    expect(reg().seasonal('afterlight')?.active).toBe(false);

    line(log.afterlightSpecialStart);              // wave-type re-arm: wakes
    expect(reg().seasonal('afterlight')?.active).toBe(true);
    bag(2);
    expect(reg().seasonal('afterlight')?.snapshot().drops[ITEM]).toBe(2);

    adv(5_100);                                    // still a wave window: parks again
    expect(reg().seasonal('afterlight')?.active).toBe(false);
    expect(ofType(events, 'afterlight').finished).toHaveLength(0);

    line(log.afterlightEnd);                       // terminal: wakes again
    expect(reg().seasonal('afterlight')?.active).toBe(true);
    bag(1);
    adv(5_100);
    expect(reg().seasonal('afterlight')).toBeNull();
    expect(ofType(events, 'afterlight').started).toHaveLength(1);
    expect(finishedDrops(events, 'afterlight')?.[ITEM]).toBe(3);
  });

  it('a Special burst (3 resets inside 1s) on a dormant run wakes once, wake event first', () => {
    const {events, line, adv, reg} = setup();
    line(log.afterlightStart);
    adv(5_100);

    events.length = 0;
    line(log.afterlightSpecialStart);
    adv(300);
    line(log.afterlightSpecialStart);
    adv(300);
    line(log.afterlightSpecialStart);

    expect(reg().seasonal('afterlight')?.active).toBe(true);
    const t = ofType(events, 'afterlight');
    expect(t.windows).toHaveLength(3);             // one window event per marker, none lost
    const firstWindow = events.findIndex(ev => ev.type === 'loot_window_started');
    const wakes = events.slice(0, firstWindow).filter(ev =>
      ev.type === 'tracker_update' && ev.tracker.seasonalType === 'afterlight' && ev.tracker.active);
    expect(wakes).toHaveLength(1);                 // exactly one wake, published before the first window
    expect(events.some(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === 'afterlight'
      && !ev.tracker.active)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Carjack
// ---------------------------------------------------------------------------

describe('carjack: Stop on a dormant tracker', () => {
  it('wakes it — credited, pickups refresh the window, expiry finishes it, a second Stop is a no-op', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);                                    // idle: parked
    expect(reg().seasonal('carjack')?.active).toBe(false);

    events.length = 0;
    line(log.s11End);
    expect(reg().seasonal('carjack')?.active).toBe(true);
    expect(ofType(events, 'carjack').windows).toHaveLength(1);

    bag(3);
    expectCredited(reg(), 'carjack', 3);

    adv(4_500);                                    // 0.5s left: a pickup re-arms to 4s
    bag(1);
    adv(3_900);
    expect(reg().seasonal('carjack')?.active).toBe(true);

    const windowsBeforeSecondStop = ofType(events, 'carjack').windows.length;
    line(log.s11End);                              // second Stop while terminal: no-op
    expect(ofType(events, 'carjack').windows).toHaveLength(windowsBeforeSecondStop);

    adv(200);
    expect(reg().seasonalsSize()).toBe(0);
    const t = ofType(events, 'carjack');
    expect(t.started).toHaveLength(0);
    expect(t.finished).toHaveLength(1);
    expect(finishedDrops(events, 'carjack')?.[ITEM]).toBe(4);

    line(log.s11End);                              // bare Stop after the run closed
    expect(reg().seasonalsSize()).toBe(0);
    expect(ofType(events, 'carjack').finished).toHaveLength(1);
  });

  it('while the session is paused the Stop credits nothing and arms nothing', () => {
    const {events, e, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);

    e.pause();
    events.length = 0;
    line(log.s11End);
    bag(3);
    expect(reg().seasonal('carjack')?.active).toBe(false);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(ofType(events, 'carjack').windows).toHaveLength(0);

    e.resume();
    expect(reg().seasonal('carjack')?.active).toBe(false);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(ofType(events, 'carjack').windows).toHaveLength(0);
  });

  it('a pickup (bag_update) never wakes a dormant carjack', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s11Start);
    adv(5_100);

    events.length = 0;
    bag(3);
    expect(reg().seasonal('carjack')?.active).toBe(false);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(events.filter(ev => ev.type === 'loot_window_started' || ev.type === 'tracker_update'
      && ev.tracker.seasonalType === 'carjack')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Clockwork
// ---------------------------------------------------------------------------

describe('clockwork: dormant podium tracker', () => {
  it('the turn-in claims drops and wakes it without a manual resume — credited, then finishes', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s7Podium);
    expect(reg().seasonal('clockwork')?.active).toBe(false);
    expect(reg().seasonal('clockwork')?.claimsDrops).toBe(false);

    events.length = 0;
    line(log.s7Turnin);
    const t = reg().seasonal('clockwork');
    expect(t?.active).toBe(true);
    expect(t?.claimsDrops).toBe(true);
    expect(reg().writer()).toBe('clockwork');
    const windows = ofType(events, 'clockwork').windows;
    expect(windows).toHaveLength(1);
    // The terminal window is the configured loot window (5s), not the 10s cogwheel timeout.
    const w = windows[0];
    if (w.type === 'loot_window_started') expect(w.deadline - w.timestamp).toBe(5_000);

    bag(3);
    expectCredited(reg(), 'clockwork', 3);

    adv(5_100);
    expect(reg().seasonal('clockwork')).toBeNull();
    const f = ofType(events, 'clockwork');
    expect(f.started).toHaveLength(0);
    expect(f.finished).toHaveLength(1);
    expect(finishedDrops(events, 'clockwork')?.[ITEM]).toBe(3);
  });

  it('a cogwheel on the dormant tracker wakes it timing-only: claims nothing, loot stays the map\'s', () => {
    const {events, line, bag, reg} = setup();
    line(log.s7Podium);

    events.length = 0;
    line(log.s7Cogwheel);
    const t = reg().seasonal('clockwork');
    expect(t?.active).toBe(true);
    expect(t?.claimsDrops).toBe(false);
    expect(reg().writer()).toBe('map');
    expect(ofType(events, 'clockwork').windows).toHaveLength(1);

    bag(2);
    expect(reg().seasonal('clockwork')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(reg().map?.snapshot().drops[ITEM]).toBe(2);
    expect(reg().session?.snapshot().dropsBySource?.map?.[ITEM]).toBe(2);
  });

  it('the cogwheel explosion still parks it again', () => {
    const {events, line, reg} = setup();
    line(log.s7Podium);
    line(log.s7Cogwheel);
    expect(reg().seasonal('clockwork')?.active).toBe(true);

    line(log.s7CogwheelEnd);
    expect(reg().seasonal('clockwork')?.active).toBe(false);
    expect(reg().seasonal('clockwork')?.isLootCollecting()).toBe(false);
    expect(ofType(events, 'clockwork').finished).toHaveLength(0);
  });

  it('a pickup never wakes the dormant tracker', () => {
    const {line, bag, reg} = setup();
    line(log.s7Podium);
    bag(2);
    expect(reg().seasonal('clockwork')?.active).toBe(false);
    expect(reg().seasonal('clockwork')?.isLootCollecting()).toBe(false);
    expect(reg().map?.snapshot().drops[ITEM]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Lunaria
// ---------------------------------------------------------------------------

describe('lunaria: strum on a dormant tracker', () => {
  it('wakes it and takes ownership back from a seasonal started while it slept', () => {
    const {events, line, bag, adv, reg} = setup();
    line(log.s14Strum);
    adv(5_100);                                    // parked
    expect(reg().seasonal('lunaria')?.active).toBe(false);
    line(log.s11Start);                            // carjack becomes the owner
    expect(reg().writer()).toBe('carjack');

    events.length = 0;
    line(log.s14Strum);
    expect(reg().seasonal('lunaria')?.active).toBe(true);
    expect(reg().writer()).toBe('lunaria');
    expect(ofType(events, 'lunaria').windows).toHaveLength(1);
    expect(ofType(events, 'lunaria').started).toHaveLength(0);

    bag(2);
    expect(reg().seasonal('lunaria')?.snapshot().drops[ITEM]).toBe(2);
    expect(reg().seasonal('carjack')?.snapshot().drops[ITEM]).toBeUndefined();
    expect(reg().map?.snapshot().drops[ITEM]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Registry / tracker level: the gate itself
// ---------------------------------------------------------------------------

type WithWake = {wakeForLoot(t: SeasonalTracker): boolean};
const wake = (r: TrackerRegistry, t: SeasonalTracker): boolean => (r as unknown as WithWake).wakeForLoot(t);

function makeRegistry(opts: {lootDurationMs?: number; session?: boolean; type?: SeasonalType} = {}) {
  const events: EngineEvent[] = [];
  const emit = internalEmit(ev => { events.push(ev); });
  const r = new TrackerRegistry();
  if (opts.session !== false) r.startSession();
  r.startMap();
  const t = r.startSeasonal({
    type:              opts.type ?? 'carjack',
    lootDurationMs:    opts.lootDurationMs ?? 5_000,
    pauseOnLootExpiry: true,
  }, emit)!;
  events.length = 0;
  return {r, t, events, emit};
}

/** A parked tracker: no timer, `active` false. */
function dormant(o: ReturnType<typeof makeRegistry>) {
  o.t.pauseTracker();
  o.events.length = 0;
}

const windowsOf = (events: EngineEvent[]) => events.filter(ev => ev.type === 'loot_window_started');

describe('TrackerRegistry.wakeForLoot', () => {
  it('is true and silent for an already active tracker', () => {
    const o = makeRegistry();
    expect(wake(o.r, o.t)).toBe(true);
    expect(o.t.active).toBe(true);
    expect(o.events).toEqual([]);
  });

  it('wakes a dormant tracker: active, owner, one published update', () => {
    const o = makeRegistry();
    dormant(o);
    expect(wake(o.r, o.t)).toBe(true);
    expect(o.t.active).toBe(true);
    expect(o.r.writer()).toBe('carjack');
    const updates = o.events.filter(ev => ev.type === 'tracker_update');
    expect(updates).toHaveLength(1);
    const u = updates[0];
    if (u.type === 'tracker_update') {
      expect(u.tracker.active).toBe(true);
      expect(u.tracker.owner).toBe(true);
    }
    expect(windowsOf(o.events)).toHaveLength(0);   // waking alone arms nothing
  });

  it('treats a missing session as not paused', () => {
    const o = makeRegistry({session: false});
    expect(o.r.session).toBeNull();
    dormant(o);
    expect(wake(o.r, o.t)).toBe(true);
    expect(o.t.active).toBe(true);
  });

  it('is false while the session is paused, and works again after the session resumes', () => {
    const o = makeRegistry();
    dormant(o);
    o.r.session!.pause();
    expect(wake(o.r, o.t)).toBe(false);
    expect(o.t.active).toBe(false);
    expect(o.events).toEqual([]);

    o.r.session!.resume();
    expect(wake(o.r, o.t)).toBe(true);
    expect(o.t.active).toBe(true);
  });

  it('is false for a finished (unregistered) tracker — no zombie revival', () => {
    const o = makeRegistry();
    dormant(o);
    o.t.finish();
    expect(o.r.seasonal('carjack')).toBeNull();
    o.events.length = 0;
    expect(wake(o.r, o.t)).toBe(false);
    expect(o.t.active).toBe(false);
    expect(o.events).toEqual([]);
  });

  it('is false for a stale tracker whose type is now held by a newer one', () => {
    const o = makeRegistry();
    dormant(o);
    o.t.finish();
    const newer = o.r.startSeasonal({type: 'carjack', lootDurationMs: 5_000, pauseOnLootExpiry: true}, o.emit)!;
    expect(newer).not.toBe(o.t);
    expect(wake(o.r, o.t)).toBe(false);
    expect(o.t.active).toBe(false);
    expect(o.r.seasonal('carjack')).toBe(newer);
  });
});

describe('SeasonalTracker arm/reset on a dormant tracker', () => {
  it('armLootTimer wakes it, publishes the wake before the window, and drops credit it', () => {
    const o = makeRegistry();
    dormant(o);
    o.t.armLootTimer();
    expect(o.t.active).toBe(true);
    expect(o.t.isLootCollecting()).toBe(true);
    expect(windowsOf(o.events)).toHaveLength(1);
    const first = o.events.find(ev => ev.type === 'tracker_update' || ev.type === 'loot_window_started');
    expect(first?.type).toBe('tracker_update');

    const res = o.r.distributeDrop(ITEM, 3, null);
    expect(res.seasonalsChanged.has('carjack')).toBe(true);
    expect(o.t.snapshot().drops[ITEM]).toBe(3);
    expect(o.r.map?.snapshot().drops[ITEM]).toBe(3);
    expect(o.r.session?.snapshot().drops[ITEM]).toBe(3);
  });

  it('resetLootTimer with no timer (parked after expiry) wakes and arms exactly once', () => {
    const o = makeRegistry({lootDurationMs: 500});
    o.t.armLootTimer();
    vi.advanceTimersByTime(600);                   // expiry parks it, timer nulled
    expect(o.t.active).toBe(false);
    expect(o.t.isLootCollecting()).toBe(false);
    o.events.length = 0;

    o.t.resetLootTimer();
    expect(o.t.active).toBe(true);
    expect(o.t.isLootCollecting()).toBe(true);
    expect(windowsOf(o.events)).toHaveLength(1);
  });

  it('armLootTimer on a finished (unregistered) tracker is a no-op', () => {
    const o = makeRegistry();
    dormant(o);
    o.t.finish();
    o.events.length = 0;
    o.t.armLootTimer();
    o.t.resetLootTimer();
    expect(o.t.active).toBe(false);
    expect(o.t.isLootCollecting()).toBe(false);
    expect(o.events).toEqual([]);
    expect(o.r.seasonal('carjack')).toBeNull();
  });
});

describe('session-paused gate on arm/reset/throttled reset', () => {
  function pausedDormant() {
    const o = makeRegistry();
    dormant(o);
    o.r.session!.pause();
    return o;
  }

  it('armLootTimer: no wake, no timer, no emit', () => {
    const o = pausedDormant();
    o.t.armLootTimer();
    expect(o.t.active).toBe(false);
    expect(o.t.isLootCollecting()).toBe(false);
    expect(o.events).toEqual([]);
  });

  it('resetLootTimer: no wake, no timer, no emit', () => {
    const o = pausedDormant();
    o.t.resetLootTimer();
    expect(o.t.active).toBe(false);
    expect(o.t.isLootCollecting()).toBe(false);
    expect(o.events).toEqual([]);
  });

  it('resetLootTimerThrottled: returns false, no wake, no timer, no emit', () => {
    const o = pausedDormant();
    expect(o.t.resetLootTimerThrottled()).toBe(false);
    expect(o.t.active).toBe(false);
    expect(o.t.isLootCollecting()).toBe(false);
    expect(o.events).toEqual([]);
  });

  it('a blocked reset does not stamp the throttle — the first post-resume reset arms', () => {
    const o = pausedDormant();
    expect(o.t.resetLootTimerThrottled()).toBe(false);
    o.r.session!.resume();
    expect(o.t.resetLootTimerThrottled()).toBe(true);
    expect(o.t.active).toBe(true);
    expect(windowsOf(o.events)).toHaveLength(1);
  });

  it('nothing is credited while blocked', () => {
    const o = pausedDormant();
    o.t.armLootTimer();
    o.r.session!.resume();                         // session credits again, tracker stays dormant
    const res = o.r.distributeDrop(ITEM, 3, null);
    expect(res.seasonalsChanged.size).toBe(0);
    expect(o.t.snapshot().drops[ITEM]).toBeUndefined();
  });
});

describe('resetLootTimerThrottled', () => {
  it('on an ACTIVE tracker a second reset inside 1s is swallowed (false)', () => {
    const o = makeRegistry();
    o.t.armLootTimer();
    expect(o.t.resetLootTimerThrottled()).toBe(true);
    o.events.length = 0;
    expect(o.t.resetLootTimerThrottled()).toBe(false);
    expect(windowsOf(o.events)).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(o.t.resetLootTimerThrottled()).toBe(true);
  });

  it('on a DORMANT tracker inside 1s of the last reset it bypasses the throttle: wakes, arms, returns true', () => {
    const o = makeRegistry({lootDurationMs: 500});
    o.t.armLootTimer();
    expect(o.t.resetLootTimerThrottled()).toBe(true);   // stamps the throttle
    vi.advanceTimersByTime(600);                        // window lapses: parked, still < 1s since the stamp
    expect(o.t.active).toBe(false);
    o.events.length = 0;

    expect(o.t.resetLootTimerThrottled()).toBe(true);
    expect(o.t.active).toBe(true);
    expect(o.t.isLootCollecting()).toBe(true);
    expect(windowsOf(o.events)).toHaveLength(1);
  });

  it('the dormant bypass stamps the throttle: an immediate second reset is swallowed', () => {
    const o = makeRegistry({lootDurationMs: 500});
    o.t.armLootTimer();
    expect(o.t.resetLootTimerThrottled()).toBe(true);
    vi.advanceTimersByTime(600);
    expect(o.t.resetLootTimerThrottled()).toBe(true);   // dormant: wake + arm
    o.events.length = 0;
    expect(o.t.resetLootTimerThrottled()).toBe(false);  // now active, inside 1s
    expect(windowsOf(o.events)).toHaveLength(0);
  });
});

describe('refreshLootTimer never wakes', () => {
  it('a parked tracker with no timer stays inactive and silent', () => {
    const o = makeRegistry({lootDurationMs: 500});
    o.t.armLootTimer();
    vi.advanceTimersByTime(600);
    expect(o.t.active).toBe(false);
    o.events.length = 0;

    o.t.refreshLootTimer();
    expect(o.t.active).toBe(false);
    expect(o.t.isLootCollecting()).toBe(false);
    expect(o.events).toEqual([]);
  });

  it('a dormant tracker whose window is still in flight is refreshed but not woken', () => {
    const o = makeRegistry();
    o.t.armLootTimer();
    o.t.pauseTracker();                            // e.g. a self-park with the timer still live
    vi.advanceTimersByTime(4_500);                 // 0.5s left: refresh would re-arm
    o.events.length = 0;

    o.t.refreshLootTimer();
    expect(o.t.active).toBe(false);
    expect(o.events.filter(ev => ev.type === 'tracker_update')).toEqual([]);
  });
});
