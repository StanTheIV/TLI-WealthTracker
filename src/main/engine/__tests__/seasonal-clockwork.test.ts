/**
 * Clockwork Ballet (S7) — podium → cogwheel fights → turn-in.
 *
 * The tracker is created dormant at the podium and only owns loot after the
 * turn-in; in between, its elapsed accumulates while cogwheel fights are live.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const startedClockwork = (events: EngineEvent[]) =>
  events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'clockwork');
const finishedClockwork = (events: EngineEvent[]) =>
  events.filter(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'clockwork');

describe('Clockwork integration', () => {
  it('the podium creates the tracker DORMANT — it exists but owns no loot', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);

    expect(ctx(e).registry.seasonal('clockwork')).toBeDefined();
    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(false);
    expect(startedClockwork(events)).toHaveLength(1);
  });

  it('drops during the cogwheel-fight phase go to map/session, NOT clockwork', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);

    // Dormant between fights: the mechanic is running but the map owns the kill.
    feed(d, e, log.bagUpdate(1, 700, 4));

    expect(ctx(e).registry.seasonal('clockwork')?.snapshot().drops[700]).toBeUndefined();
    expect(ctx(e).registry.session?.snapshot().drops[700]).toBe(4);
    expect(ctx(e).registry.map?.snapshot().drops[700]).toBe(4);
  });

  // The bug this guards: an ACTIVE seasonal is normally the drop writer, so a
  // tracker merely awake for a cogwheel fight would steal the map's kills.
  it('drops DURING a live cogwheel fight still go to the map, not clockwork', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);

    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(true);
    expect(ctx(e).registry.writer()).toBe('map');

    feed(d, e, log.bagUpdate(1, 700, 6));

    expect(ctx(e).registry.seasonal('clockwork')?.snapshot().drops[700]).toBeUndefined();
    expect(ctx(e).registry.map?.snapshot().drops[700]).toBe(6);
    expect(ctx(e).registry.session?.snapshot().dropsBySource?.map?.[700]).toBe(6);
  });

  it('the fight phase never flags clockwork as the drop owner', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);

    const owned = events.some(ev =>
      (ev.type === 'tracker_started' || ev.type === 'tracker_update') &&
      ev.tracker.seasonalType === 'clockwork' && ev.tracker.owner === true);
    expect(owned).toBe(false);
  });

  // The cogwheel's mobs scatter across the whole map, so killing them anywhere
  // kept the window alive — 1.45x over-counted fight time, one encounter
  // clocking 85.2s of a 109.5s run. Only the machine attests engagement.
  it('cogwheel MOB spawns do not keep the fight window alive', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);

    // Mobs keep arriving across the map, but the machine has gone quiet.
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(1_000);
      feed(d, e, log.s7CogwheelMob);
    }

    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(false);
  });

  // The spin-up loop repeats every ~2.8s, so a fight outlasting the 10s timeout
  // keeps the row lit rather than greying out mid-fight.
  it('each cogwheel pulse re-arms the timeout', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);

    for (let i = 0; i < 8; i++) {
      feed(d, e, log.s7Cogwheel);
      vi.advanceTimersByTime(3_000); // 24s total, well past one 10s window
      expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(true);
    }
  });

  // The renderer freezes a row's clock on `active: false`, so parking has to be
  // PUBLISHED, not just done. Ownership updates alone never covered it: clockwork
  // owns nothing during the fight phase, so it has no ownership change to
  // piggyback on and the row went on ticking from its last snapshot.
  it('parking and waking are both pushed to the renderer', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    const clockworkUpdates = () => events.flatMap(ev =>
      ev.type === 'tracker_update' && ev.tracker.seasonalType === 'clockwork'
        ? [ev.tracker.active]
        : []);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);

    events.length = 0;
    feed(d, e, log.s7CogwheelEnd);
    expect(clockworkUpdates()).toEqual([false]);

    events.length = 0;
    feed(d, e, log.s7Cogwheel);
    expect(clockworkUpdates()).toEqual([true]);
  });

  it('a cogwheel activating resumes the tracker, and its explosion parks it again', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);

    feed(d, e, log.s7Cogwheel);
    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(true);

    feed(d, e, log.s7CogwheelEnd);
    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(false);
    expect(ctx(e).registry.seasonal('clockwork')?.isLootCollecting()).toBe(false);
  });

  it('a later fight resumes the SAME run — one tracker across the whole map', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);

    for (let i = 0; i < 3; i++) {
      feed(d, e, log.s7Cogwheel);
      vi.advanceTimersByTime(2_000);
      feed(d, e, log.s7CogwheelEnd);
      vi.advanceTimersByTime(30_000); // long gap between fights
    }

    expect(startedClockwork(events)).toHaveLength(1);
    expect(finishedClockwork(events)).toHaveLength(0);
    expect(ctx(e).registry.seasonal('clockwork')).toBeDefined();
  });

  it('repeated explosions park once — the extras are no-ops', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);

    for (let i = 0; i < 5; i++) feed(d, e, log.s7CogwheelEnd);

    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(false);
    expect(finishedClockwork(events)).toHaveLength(0);
  });

  it('an abandoned cogwheel PARKS the tracker rather than ending the run', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);

    vi.advanceTimersByTime(10_100); // walked away — no explosion, no pulses

    expect(ctx(e).registry.seasonal('clockwork')).toBeDefined();
    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(false);
    expect(finishedClockwork(events)).toHaveLength(0);
  });

  it('a pickup during a fight does NOT extend the timeout', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);

    vi.advanceTimersByTime(6_000);
    feed(d, e, log.bagUpdate(1, 700, 2)); // must not buy more time
    vi.advanceTimersByTime(4_200);

    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(false);
  });

  it('the turn-in activates the tracker and arms a TERMINAL window', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);
    feed(d, e, log.s7CogwheelEnd);
    feed(d, e, log.s7Turnin);

    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(true);
    expect(finishedClockwork(events)).toHaveLength(0);

    vi.advanceTimersByTime(5_100);

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(finishedClockwork(events)).toHaveLength(1);
  });

  // A bonus cogwheel pays out during the reward sequence: 14 of 16 measured
  // turn-ins had a voucher land 1-2ms later. Parking there cancelled the loot
  // window and stranded the whole burst.
  it('a bonus voucher right after the turn-in does NOT cancel the loot window', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);
    feed(d, e, log.s7Turnin);
    feed(d, e, log.s7CogwheelEnd); // the bonus cogwheel
    feed(d, e, log.s7CogwheelEnd);

    expect(ctx(e).registry.seasonal('clockwork')?.active).toBe(true);
    expect(ctx(e).registry.seasonal('clockwork')?.isLootCollecting()).toBe(true);

    // The reward burst lands several seconds later and must still be credited.
    vi.advanceTimersByTime(3_200);
    feed(d, e, log.bagUpdate(1, 700, 9));
    expect(ctx(e).registry.seasonal('clockwork')?.snapshot().drops[700]).toBe(9);

    vi.advanceTimersByTime(5_100);
    expect(finishedClockwork(events)).toHaveLength(1);
  });

  it('a bonus mob spawn after the turn-in does not reopen the fight phase', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Turnin);
    feed(d, e, log.s7Cogwheel);

    // Still terminal: the window must finish the run, not park it.
    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });

  it('the reward burst after the turn-in is attributed to clockwork', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Turnin);

    feed(d, e, log.bagUpdate(1, 700, 7));

    expect(ctx(e).registry.seasonal('clockwork')?.snapshot().drops[700]).toBe(7);
    expect(ctx(e).registry.session?.snapshot().drops[700]).toBe(7);
    expect(ctx(e).registry.map?.snapshot().drops[700]).toBe(7); // drops through (in-map)
  });

  // A failed run emits the Success push first, then opens the fail page ~2s
  // later — and still drops loot. The turn-in owns the window either way.
  it('a failed run still credits its loot, and the fail page does not re-arm', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Turnin);
    feed(d, e, log.s7Fail);

    feed(d, e, log.bagUpdate(1, 700, 3));
    expect(ctx(e).registry.seasonal('clockwork')?.snapshot().drops[700]).toBe(3);

    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(finishedClockwork(events)).toHaveLength(1);
  });

  it('a mob spawn with no podium does NOT create a tracker', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.s7Cogwheel);
    feed(d, e, log.s7CogwheelEnd);

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });

  it('a duplicate turn-in does not restart the run', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Turnin);
    feed(d, e, log.s7Turnin);

    expect(startedClockwork(events)).toHaveLength(1);
  });

  it('entering town finishes a dormant mid-map run with no double-finish', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Cogwheel);
    feed(d, e, log.s7CogwheelEnd); // parked, never turned in

    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(finishedClockwork(events)).toHaveLength(1);

    events.length = 0;
    vi.advanceTimersByTime(5_100);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('entering town during the terminal window finishes immediately', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 700, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s7Podium);
    feed(d, e, log.s7Turnin);

    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(finishedClockwork(events)).toHaveLength(1);

    events.length = 0;
    vi.advanceTimersByTime(5_100);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });
});
