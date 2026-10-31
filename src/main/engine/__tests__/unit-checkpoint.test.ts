/**
 * Step 2.1b — every `unit_finished` carries a `checkpoint`: the SESSION snapshot
 * (drops, dropsBySource, spent) plus mapTime (ms) and mapCount as they are at
 * that moment, stamped by the Engine at emit. Production chain under fake timers.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import {checkCheckpoints, checkUnits} from '@/test/unit-invariant';
import {
  ARCANA_FIGHT, MAP, TOWN, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {bootSession, resetWith, unitsWithCheckpoint} from './identity-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const LOOT     = 800;   // slot 1
const MATERIAL = 100;   // slot 2, starts at 10

function rig() {
  const events: EngineEvent[] = [];
  const e: Engine = createEngine(events);
  const d = createDispatcher();
  bootSession(d, e, [{slotId: 1, itemId: LOOT, quantity: 0}, {slotId: 2, itemId: MATERIAL, quantity: 10}]);
  let lootTotal = 0;
  let materialLeft = 10;
  return {
    e, d, events,
    line:  (l: string) => feed(d, e, l),
    go:    (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
    drop:  (n = 1) => { lootTotal += n; feed(d, e, log.bagUpdate(1, LOOT, lootTotal)); },
    /** Spend 3 of MATERIAL in town: the next town -> map entry costs it. */
    spend3: () => { materialLeft -= 3; feed(d, e, log.bagUpdate(2, MATERIAL, materialLeft)); },
    adv:   (ms: number) => vi.advanceTimersByTime(ms),
    units: () => unitsWithCheckpoint(events),
    liveSession: () => ctx(e).registry.session!.snapshot(),
  };
}

describe('map unit checkpoint', () => {
  it('carries the session state at the unit: drops, entry cost, per-source drops, mapTime, mapCount', () => {
    const o = rig();
    o.spend3();
    o.go(TOWN, MAP);
    o.adv(60_000);
    o.drop(5);
    o.go(MAP, TOWN);

    const [u] = o.units();
    expect(u.checkpoint).toBeDefined();
    expect(u.checkpoint.session.kind).toBe('session');
    expect(u.checkpoint.session.drops[LOOT]).toBe(5);
    expect(u.checkpoint.session.spent).toEqual({[MATERIAL]: 3});
    expect(u.checkpoint.session.dropsBySource).toEqual({map: {[LOOT]: 5}});
    expect(u.checkpoint.mapTime).toBe(60_000);
    expect(u.checkpoint.mapCount).toBe(1);
  });

  it('is exactly the live session snapshot at the moment of the unit', () => {
    const o = rig();
    o.spend3();
    o.go(TOWN, MAP);
    o.adv(20_000);
    o.drop(2);
    o.go(MAP, TOWN);

    expect(o.units()[0].checkpoint.session).toEqual(o.liveSession());
  });

  it("includes the finished children's loot, attributed to their own source", () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.drop(3);                         // map loot
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);           // map frozen for the fight
    o.adv(20_000);
    o.drop(2);                         // arcana loot
    o.go(ARCANA_FIGHT, MAP);
    o.adv(5_000);
    o.go(MAP, TOWN);

    const [u] = o.units();
    expect(u.overlaps.map(c => c.tracker.seasonalType)).toEqual(['arcana']);
    expect(u.checkpoint.session.drops[LOOT]).toBe(5);
    expect(u.checkpoint.session.dropsBySource).toEqual({map: {[LOOT]: 3}, arcana: {[LOOT]: 2}});
    expect(u.checkpoint.mapTime).toBe(15_000);   // the fight is not map time
    expect(u.checkpoint.mapCount).toBe(1);
  });

  it('the second map: cumulative drops, spent, mapTime and mapCount', () => {
    const o = rig();
    o.spend3();
    o.go(TOWN, MAP);
    o.adv(30_000);
    o.drop(4);
    o.go(MAP, TOWN);
    o.spend3();
    o.go(TOWN, MAP);
    o.adv(45_000);
    o.drop(1);
    o.go(MAP, TOWN);

    const [first, second] = o.units();
    expect(first.checkpoint.mapCount).toBe(1);
    expect(first.checkpoint.mapTime).toBe(30_000);
    expect(first.checkpoint.session.drops[LOOT]).toBe(4);
    expect(first.checkpoint.session.spent).toEqual({[MATERIAL]: 3});

    expect(second.checkpoint.mapCount).toBe(2);
    expect(second.checkpoint.mapTime).toBe(75_000);
    expect(second.checkpoint.session.drops[LOOT]).toBe(5);
    expect(second.checkpoint.session.spent).toEqual({[MATERIAL]: 6});
    expect(second.checkpoint.session.dropsBySource).toEqual({map: {[LOOT]: 5}});
  });

  it('an emitted checkpoint is a snapshot: later play does not mutate it', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.drop(2);
    o.go(MAP, TOWN);
    const frozen = JSON.parse(JSON.stringify(o.units()[0].checkpoint));

    o.go(TOWN, MAP);
    o.drop(7);
    o.adv(5_000);
    o.go(MAP, TOWN);

    expect(o.units()[0].checkpoint).toEqual(frozen);
  });

  it('mapTime excludes paused spans', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.e.pause();
    o.adv(20_000);
    o.e.resume();
    o.adv(5_000);
    o.go(MAP, TOWN);

    expect(o.units()[0].checkpoint.mapTime).toBe(15_000);
  });

  it('carries the sessions elapsed in the snapshot', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(12_000);
    o.go(MAP, TOWN);
    expect(o.units()[0].checkpoint.session.elapsed).toBe(12_000);
  });
});

describe('standalone seasonal unit checkpoint', () => {
  it('a town Arcana fight with no map: drops and source included, mapCount 0, mapTime 0', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.go(TOWN, ARCANA_FIGHT);
    o.adv(5_000);
    o.drop(4);
    o.go(ARCANA_FIGHT, TOWN);

    const [u] = o.units();
    expect(u.tracker.seasonalType).toBe('arcana');
    expect(u.checkpoint.session.drops[LOOT]).toBe(4);
    expect(u.checkpoint.session.dropsBySource).toEqual({arcana: {[LOOT]: 4}});
    expect(u.checkpoint.mapCount).toBe(0);
    expect(u.checkpoint.mapTime).toBe(0);
  });

  it('after a finished map: standalone unit sees that map in mapCount/mapTime and the map loot', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.drop(2);
    o.go(MAP, TOWN);
    o.line(log.s9Minigame);
    o.go(TOWN, ARCANA_FIGHT);
    o.drop(3);
    o.go(ARCANA_FIGHT, TOWN);

    const [, standalone] = o.units();
    expect(standalone.tracker.kind).toBe('seasonal');
    expect(standalone.checkpoint.mapCount).toBe(1);
    expect(standalone.checkpoint.mapTime).toBe(10_000);
    expect(standalone.checkpoint.session.drops[LOOT]).toBe(5);
    expect(standalone.checkpoint.session.dropsBySource).toEqual({map: {[LOOT]: 2}, arcana: {[LOOT]: 3}});
  });
});

describe('promoted units at stop', () => {
  it('each promoted child carries the session state at stop, mapCount counting the live map', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.drop(1);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(5_000);
    o.drop(2);
    o.go(ARCANA_FIGHT, MAP);           // arcana finished: a child waiting for its map
    expect(o.units()).toHaveLength(0);
    const live = o.liveSession();
    o.e.stop();

    const [u] = o.units();
    expect(u.tracker.seasonalType).toBe('arcana');
    expect(u.checkpoint.session).toEqual(live);
    expect(u.checkpoint.session.drops[LOOT]).toBe(3);
    expect(u.checkpoint.mapCount).toBe(1);
    expect(u.checkpoint.mapTime).toBe(0);   // the live map is dropped, never accumulated

    const fin = o.events.find(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'session');
    expect(fin?.type === 'tracker_finished' ? fin.sessionMeta : null).toMatchObject({
      mapCount: u.checkpoint.mapCount, mapTime: u.checkpoint.mapTime,
    });
  });
});

describe('after a reset', () => {
  it('the rebuilt map unit starts the counts over: mapCount 1, only post-reset loot, carried entry cost', () => {
    const o = rig();
    o.spend3();
    o.go(TOWN, MAP);
    o.drop(9);                         // discarded by the reset
    o.adv(10_000);
    resetWith(o.e, {sessionId: 'after-reset', name: 'After reset'});
    o.adv(7_000);
    o.drop(2);
    o.go(MAP, TOWN);

    const [u] = o.units();
    expect(u.checkpoint.mapCount).toBe(1);
    expect(u.checkpoint.mapTime).toBe(7_000);
    expect(u.checkpoint.session.drops[LOOT]).toBe(2);
    expect(u.checkpoint.session.spent).toEqual({[MATERIAL]: 3});
    expect(u.checkpoint.session.dropsBySource).toEqual({map: {[LOOT]: 2}});
  });
});

describe('checkpoint invariant over a busy session', () => {
  it('checkCheckpoints (and checkUnits) are clean', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.line(log.s9Close);                 // dormant town panel -> standalone unit
    o.spend3();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.drop(3);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(5_000);
    o.drop(2);
    o.go(ARCANA_FIGHT, MAP);
    o.line(log.s14Strum);
    o.drop(1);
    o.adv(8_000);
    o.go(MAP, TOWN);
    o.spend3();
    o.go(TOWN, MAP);
    o.e.pause();
    o.adv(9_000);
    o.e.resume();
    o.adv(4_000);
    o.go(MAP, TOWN);
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.go(ARCANA_FIGHT, MAP);
    o.e.stop();

    expect(o.units().length).toBeGreaterThanOrEqual(3);
    expect(checkCheckpoints(o.events)).toEqual([]);
    expect(checkUnits(o.events)).toEqual([]);
  });

  it('checkCheckpoints flags a unit without a checkpoint', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.go(MAP, TOWN);
    const stripped = o.events.map(ev => {
      if (ev.type !== 'unit_finished') return ev;
      const {checkpoint: _drop, ...rest} = ev;
      void _drop;
      return rest as EngineEvent;
    });
    expect(checkCheckpoints(stripped)).not.toEqual([]);
  });
});
