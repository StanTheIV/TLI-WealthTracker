/**
 * Step 2.1b — the pre-init rule. A unit exists only while a session does:
 * a map (or standalone seasonal) that FINISHES before the bag baseline lands
 * emits no unit and is not counted. If the baseline lands while the player is
 * inside a map, that map is map #1 of the new session (rebuilt like
 * Engine.reset: fresh tracker, so only post-init time counts).
 *   mapCount = (loaded ?? 0) + (inMap ? 1 : 0),  mapTime = loaded ?? 0.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import {checkCheckpoints} from '@/test/unit-invariant';
import {
  ARCANA_FIGHT, MAP, TOWN, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {
  beginSession, completeInit, metaOf, sessionStarts, unitsWithCheckpoint, type SeedData,
} from './identity-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const LOOT = 800;
const INV  = [{slotId: 1, itemId: LOOT, quantity: 0}];

const SAVED: SeedData = {
  sessionId: 'saved-1', name: 'Saved',
  drops: {[LOOT]: 3}, dropsBySource: {map: {[LOOT]: 3}}, spent: {},
  totalTime: 120, mapTime: 30, mapCount: 4,
};

/** An engine started but NOT yet initialized (phase `initializing`). */
function rig(loaded?: SeedData) {
  const events: EngineEvent[] = [];
  const e: Engine = createEngine(events);
  const d = createDispatcher();
  beginSession(e, {loaded});
  let lootTotal = 0;
  return {
    e, d, events,
    go:    (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
    line:  (l: string) => feed(d, e, l),
    drop:  (n = 1) => { lootTotal += n; feed(d, e, log.bagUpdate(1, LOOT, lootTotal)); },
    adv:   (ms: number) => vi.advanceTimersByTime(ms),
    init:  () => completeInit(d, e, INV),
    units: () => unitsWithCheckpoint(events),
    meta:  () => metaOf(sessionStarts(events)[0]),
  };
}

describe('maps that finish before init are not units', () => {
  it('a map entered and left during initializing: no unit now, none after init; counts stay 0', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(30_000);
    o.go(MAP, TOWN);
    expect(o.units()).toEqual([]);

    o.init();
    expect(o.units()).toEqual([]);
    expect(ctx(o.e).mapCount).toBe(0);
    expect(ctx(o.e).accumulatedMapTime).toBe(0);
    expect(o.meta()).toMatchObject({mapCount: 0, mapTime: 0});
    expect(ctx(o.e).inMap).toBe(false);
  });

  it('several pre-init maps: still nothing', () => {
    const o = rig();
    for (let i = 0; i < 3; i++) {
      o.go(TOWN, MAP);
      o.adv(10_000);
      o.go(MAP, TOWN);
    }
    o.init();
    o.e.stop();

    expect(o.units()).toEqual([]);
  });

  it('the first real map after such an init is map #1 with only its own time', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(30_000);
    o.go(MAP, TOWN);
    o.init();
    o.go(TOWN, MAP);
    o.adv(12_000);
    o.go(MAP, TOWN);

    const [u] = o.units();
    expect(o.units()).toHaveLength(1);
    expect(u.checkpoint.mapCount).toBe(1);
    expect(u.checkpoint.mapTime).toBe(12_000);
  });

  it('a map with a seasonal child finishing before init emits neither unit', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s7Podium);
    o.adv(5_000);
    o.go(MAP, TOWN);
    o.init();
    o.e.stop();

    expect(o.units()).toEqual([]);
  });

  it('a standalone seasonal that finishes during initializing emits no unit', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.go(TOWN, ARCANA_FIGHT);
    o.adv(5_000);
    o.go(ARCANA_FIGHT, TOWN);
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.units()).toEqual([]);

    o.init();
    o.e.stop();
    expect(o.units()).toEqual([]);
  });
});

describe('init landing inside a map', () => {
  it('the map becomes map #1 of the session: sessionMeta mapCount 1, mapTime 0', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(15_000);
    o.init();

    expect(ctx(o.e).inMap).toBe(true);
    expect(ctx(o.e).mapCount).toBe(1);
    expect(ctx(o.e).accumulatedMapTime).toBe(0);
    expect(o.meta()).toMatchObject({mapCount: 1, mapTime: 0});
  });

  it('the renderer is told about the rebuilt map after the session starts (map_started #1 + a map tracker_started)', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.init();

    const types = o.events.map(ev => (ev.type === 'tracker_started' ? `started:${ev.tracker.kind}` : ev.type));
    const session = types.indexOf('started:session');
    const mapStarted = o.events.findIndex(ev => ev.type === 'map_started');
    expect(session).toBeGreaterThanOrEqual(0);
    expect(mapStarted).toBeGreaterThan(session);
    expect((o.events[mapStarted] as Extract<EngineEvent, {type: 'map_started'}>).mapCount).toBe(1);
    expect(types.indexOf('started:map')).toBeGreaterThan(session);
    expect(ctx(o.e).registry.map?.elapsed()).toBe(0);
  });

  it('leaving it yields exactly one unit: map #1, only post-init time and loot, checkpoint counts 1 / its time', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(15_000);                     // pre-init time is not the session's
    o.init();
    o.adv(20_000);
    o.drop(3);
    o.go(MAP, TOWN);

    expect(o.units()).toHaveLength(1);
    const [u] = o.units();
    expect(u.tracker.kind).toBe('map');
    expect(u.tracker.elapsed).toBe(20_000);
    expect(u.tracker.drops[LOOT]).toBe(3);
    expect(u.checkpoint.mapCount).toBe(1);
    expect(u.checkpoint.mapTime).toBe(20_000);
    expect(u.checkpoint.session.drops[LOOT]).toBe(3);
    expect(u.checkpoint.session.dropsBySource).toEqual({map: {[LOOT]: 3}});
    expect(checkCheckpoints(o.events)).toEqual([]);
  });

  it('the next map after that is map #2', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.init();
    o.adv(5_000);
    o.go(MAP, TOWN);
    o.go(TOWN, MAP);
    o.adv(7_000);
    o.go(MAP, TOWN);

    const [first, second] = o.units();
    expect(first.checkpoint.mapCount).toBe(1);
    expect(second.checkpoint.mapCount).toBe(2);
    expect(second.checkpoint.mapTime).toBe(12_000);
  });

  it('earlier pre-init maps are not counted, only the one we are inside', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(5_000);
    o.go(MAP, TOWN);
    o.go(TOWN, MAP);
    o.init();

    expect(ctx(o.e).mapCount).toBe(1);
    o.go(MAP, TOWN);
    expect(o.units()).toHaveLength(1);
    expect(o.units()[0].checkpoint.mapCount).toBe(1);
  });

  it('stopping inside the map: no unit, session meta counts the live map once', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.init();
    o.adv(5_000);
    o.e.stop();

    expect(o.units()).toEqual([]);
    const fin = o.events.find(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'session');
    expect(fin?.type === 'tracker_finished' ? fin.sessionMeta : null).toEqual({mapTime: 0, mapCount: 1});
  });
});

describe('continue + pre-init maps', () => {
  it('a map finished before init adds nothing: mapCount / mapTime are the loaded values', () => {
    const o = rig(SAVED);
    o.go(TOWN, MAP);
    o.adv(40_000);
    o.go(MAP, TOWN);
    o.init();

    expect(ctx(o.e).mapCount).toBe(4);
    expect(ctx(o.e).accumulatedMapTime).toBe(30_000);
    expect(o.meta()).toMatchObject({mapCount: 4, mapTime: 30_000, continued: true});
    expect(o.units()).toEqual([]);
  });

  it('init inside a map: mapCount = loaded + 1, mapTime = loaded; its unit is map #5', () => {
    const o = rig(SAVED);
    o.go(TOWN, MAP);
    o.adv(40_000);
    o.init();
    expect(o.meta()).toMatchObject({mapCount: 5, mapTime: 30_000, continued: true});

    o.adv(10_000);
    o.go(MAP, TOWN);
    const [u] = o.units();
    expect(o.units()).toHaveLength(1);
    expect(u.tracker.elapsed).toBe(10_000);
    expect(u.checkpoint.mapCount).toBe(5);
    expect(u.checkpoint.mapTime).toBe(40_000);
  });

  it('the seed survives the map rebuild: session drops and elapsed are the seeded values', () => {
    const o = rig(SAVED);
    o.go(TOWN, MAP);
    o.init();

    const [started] = sessionStarts(o.events);
    expect(started.tracker.drops).toEqual({[LOOT]: 3});
    expect(started.tracker.elapsed).toBe(120_000);
    o.drop(2);
    o.go(MAP, TOWN);
    expect(o.units()[0].checkpoint.session.drops[LOOT]).toBe(5);
  });
});
