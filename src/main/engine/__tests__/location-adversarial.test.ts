/**
 * Adversarial ctx.location cases: start-of-tracking, detours, repeated
 * transitions, Engine.reset(), town buffer timing, ownerless loot, map
 * material around town panels, and the zone_change.entering contract.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TARTARUS_FIGHT, TOWN, VOREX_REWARD,
  boot, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {UNKNOWN_SCENE, dropEvents, dropsBySource, sessionDrops} from './location-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const ITEM = 800;

function setup(threshold?: number) {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  if (threshold !== undefined) e.setLowStockThreshold(threshold);
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 10}]);
  events.length = 0;
  let qty = 10;
  const line = (l: string) => feed(d, e, l);
  const go   = (from: string, to: string) => line(log.zoneTransition(from, to));
  const set  = (q: number) => { qty = q; line(log.bagUpdate(1, ITEM, q)); };
  const add  = (n: number) => set(qty + n);
  const settle = () => vi.advanceTimersByTime(2_000);
  const warnings = () => events.filter((ev): ev is Extract<EngineEvent, {type: 'map_material_warning'}> => ev.type === 'map_material_warning');
  return {events, d, e, line, go, set, add, settle, warnings, reg: () => ctx(e).registry};
}

describe('tracking starts mid-scene', () => {
  it('started in a map: bag change before any transition is not credited; first transition map -> town starts and ends nothing', () => {
    const {e, events, go, add, settle} = setup();
    add(5);
    settle();
    expect(ctx(e).location).toBe('other');
    expect(dropEvents(events)).toHaveLength(0);
    expect(sessionDrops(e)).toEqual({});

    go(MAP, TOWN);
    expect(ctx(e).location).toBe('town');
    expect(ctx(e).prevLocation).toBe('map');
    expect(ctx(e).transition).toEqual({from: 'map', to: 'town', mapStarted: false});
    expect(ctx(e).mapCount).toBe(0);
    expect(events.some(ev => ev.type === 'map_ended' || ev.type === 'map_started')).toBe(false);
  });

  it('started in the hub: first transition hub -> sub-map is hub, starts no map; loot is ownerless (session only, as today)', () => {
    const {e, events, go, add, settle, reg} = setup();
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    const c = ctx(e);
    expect(c.location).toBe('hub');
    expect(c.transition).toEqual({from: 'hub', to: 'hub', mapStarted: false});
    expect(c.mapCount).toBe(0);
    expect(reg().map).toBeNull();
    expect(reg().seasonal('sandlord')).toBeNull();   // no entry transition was seen

    add(4);
    settle();
    // Characterization (user decision: ownerless loot kept as today).
    expect(sessionDrops(e)).toEqual({[ITEM]: 4});
    expect(dropsBySource(e)).toEqual({});
    expect(dropEvents(events)).toHaveLength(1);
  });

  it('started in the hub, then hub -> town: no teardown errors, location town', () => {
    const {e, go} = setup();
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    go(SANDLORD_SUB_MAP, TOWN);
    expect(ctx(e).location).toBe('town');
    expect(ctx(e).prevLocation).toBe('hub');
  });

  it('started in a map: a seasonal-scene transition first (map -> fight) is seasonal-scene with prev map', () => {
    const {e, go} = setup();
    go(MAP, ARCANA_FIGHT);
    expect(ctx(e).transition).toEqual({from: 'map', to: 'seasonal-scene', mapStarted: false});
    expect(ctx(e).inMap).toBe(false);
  });
});

describe('hub detours and repeated transitions', () => {
  it('hub -> arcana fight -> hub: no map is ever created and the bubble run survives', () => {
    const {e, go, reg} = setup();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, ARCANA_FIGHT);
    expect(ctx(e).location).toBe('seasonal-scene');
    go(ARCANA_FIGHT, SANDLORD_HUB);
    expect(ctx(e).location).toBe('hub');
    expect(reg().map).toBeNull();
    expect(ctx(e).mapCount).toBe(0);
    expect(reg().seasonal('sandlord')).not.toBeNull();
  });

  it('hub -> fight -> sub-map (stickiness lost): the bubble still stops a map from starting', () => {
    const {e, go, add, settle, reg} = setup();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, ARCANA_FIGHT);
    go(ARCANA_FIGHT, SANDLORD_SUB_MAP);
    expect(reg().map).toBeNull();
    expect(ctx(e).mapCount).toBe(0);
    expect(ctx(e).transition?.mapStarted).toBe(false);
    expect(ctx(e).isLootContext()).toBe(true);
    add(3);
    settle();
    expect(reg().seasonal('sandlord')?.snapshot().drops).toEqual({[ITEM]: 3});
  });

  it('hub -> fight -> town finishes the hub run', () => {
    const {e, go, reg} = setup();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, ARCANA_FIGHT);
    go(ARCANA_FIGHT, TOWN);
    expect(reg().seasonalsSize()).toBe(0);
    expect(ctx(e).location).toBe('town');
  });

  it('two consecutive transitions to the same map do not start a second map', () => {
    const {e, go} = setup();
    go(TOWN, MAP);
    go(TOWN, MAP);
    expect(ctx(e).mapCount).toBe(1);
    expect(ctx(e).transition).toEqual({from: 'town', to: 'map', mapStarted: false});
  });

  it('town -> map twice does not double-promote map material', () => {
    const {go, set, warnings} = setup(100);
    set(9);
    go(TOWN, MAP);
    go(TOWN, MAP);                       // same scene again: not a creation
    expect(warnings()).toHaveLength(1);
    go(MAP, TOWN);
    set(8);
    go(TOWN, MAP);
    expect(warnings().at(-1)?.items).toEqual([{itemId: ITEM, quantity: 8}]);
  });

  it('town -> town twice: location stays town, no map, no crash', () => {
    const {e, go} = setup();
    go(TOWN, TOWN);
    go(TOWN, TOWN);
    expect(ctx(e).location).toBe('town');
    expect(ctx(e).mapCount).toBe(0);
  });

  it('hub -> hub (same scene twice) keeps one bubble run', () => {
    const {e, go, events} = setup();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, SANDLORD_HUB);
    expect(events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'sandlord')).toHaveLength(1);
    expect(ctx(e).location).toBe('hub');
  });
});

describe('Engine.reset() and location', () => {
  it('reset in town keeps location town; the next town -> map is map #1 with mapStarted', () => {
    const {e, go} = setup();
    go(TOWN, MAP);
    go(MAP, TOWN);
    e.reset();
    expect(ctx(e).location).toBe('town');
    go(TOWN, MAP);
    expect(ctx(e).mapCount).toBe(1);
    expect(ctx(e).transition?.mapStarted).toBe(true);
  });

  it('reset mid-map then map -> town: the re-created map tracker is finished and counted once', () => {
    const {e, go, events} = setup();
    go(TOWN, MAP);
    vi.advanceTimersByTime(5_000);
    e.reset();
    expect(ctx(e).mapCount).toBe(1);
    vi.advanceTimersByTime(3_000);
    go(MAP, TOWN);
    expect(ctx(e).accumulatedMapTime).toBe(3_000);
    expect(ctx(e).prevLocation).toBe('map');
    expect(events.filter(ev => ev.type === 'map_ended')).toHaveLength(1);
  });

  it('reset mid-hub keeps location hub; a sub-map transition afterwards starts no phantom map', () => {
    const {e, go, reg} = setup();
    go(TOWN, SANDLORD_HUB);
    e.reset();
    expect(ctx(e).location).toBe('hub');
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    expect(ctx(e).location).toBe('hub');
    expect(reg().map).toBeNull();
    expect(ctx(e).mapCount).toBe(0);
  });

  it('reset mid-seasonal-scene keeps seasonal-scene', () => {
    const {e, go} = setup();
    go(TOWN, VOREX_REWARD);
    e.reset();
    expect(ctx(e).location).toBe('seasonal-scene');
    expect(ctx(e).inMap).toBe(false);
  });

  it('stop() clears location; a restarted engine begins at other with no transition', () => {
    const {e, go} = setup();
    go(TOWN, MAP);
    e.stop();
    expect(ctx(e).location).toBe('other');
    expect(ctx(e).prevLocation).toBe('other');
    expect(ctx(e).transition).toBeNull();
  });
});

describe('town buffer timing', () => {
  it('town change, panel opens within 1.5 s, timer fires: nothing credited', () => {
    const {e, events, line, add} = setup();
    line(log.zoneTransition(MAP, TOWN));
    add(5);
    vi.advanceTimersByTime(500);
    line(log.s9Minigame);
    vi.advanceTimersByTime(1_500);
    expect(dropEvents(events)).toHaveLength(0);
    expect(sessionDrops(e)).toEqual({});
    expect(dropsBySource(e)).toEqual({});
  });

  it('town change, then town -> map within 1.5 s: credited as the map pre-entry flush (today, 1.2 changes it)', () => {
    const {e, go, add, reg} = setup();
    go(MAP, TOWN);
    add(-3);                             // a spend: entry material
    vi.advanceTimersByTime(800);
    go(TOWN, MAP);
    expect(reg().map?.snapshot().drops).toEqual({[ITEM]: -3});
    expect(sessionDrops(e)).toEqual({[ITEM]: -3});
    expect(e.getLastMapSpends()).toEqual({[ITEM]: 3});
    vi.advanceTimersByTime(5_000);        // the cleared timer does not double-flush
    expect(sessionDrops(e)).toEqual({[ITEM]: -3});
  });

  it('town change, then town -> unrecognised scene within 1.5 s: discarded, not credited', () => {
    const {e, events, go, add} = setup();
    go(MAP, TOWN);
    add(-2);
    go(TOWN, UNKNOWN_SCENE);
    vi.advanceTimersByTime(3_000);
    expect(dropEvents(events)).toHaveLength(0);
    expect(sessionDrops(e)).toEqual({});
  });

  it('town change, then town -> arcana fight within 1.5 s with the panel open: flushed into the fight run', () => {
    const {e, line, go, add, reg} = setup();
    go(MAP, TOWN);
    line(log.s9Minigame);
    add(-2);
    go(TOWN, ARCANA_FIGHT);
    expect(reg().seasonal('arcana')?.snapshot().drops).toEqual({[ITEM]: -2});
    expect(sessionDrops(e)).toEqual({[ITEM]: -2});
  });

  it('a second town change after the timer fired starts a fresh 1.5 s window', () => {
    const {e, events, go, add} = setup();
    go(MAP, TOWN);
    add(1);
    vi.advanceTimersByTime(1_600);
    add(1);
    vi.advanceTimersByTime(1_600);
    expect(dropEvents(events)).toHaveLength(0);
    expect(sessionDrops(e)).toEqual({});
  });
});

describe('map material around town panels', () => {
  it('a spend with an Arcana panel opened and closed in town still counts for the next map', () => {
    const {line, go, set, warnings} = setup(100);
    set(9);
    line(log.s9Minigame);
    line(log.s9Close);
    go(TOWN, MAP);                       // streak 1
    go(MAP, TOWN);
    set(8);
    line(log.s16BoardOpen);
    line(log.s16BoardClose);
    go(TOWN, MAP);                       // streak 2 -> warn
    expect(warnings().at(-1)?.items).toEqual([{itemId: ITEM, quantity: 8}]);
  });

  it('first map after start: a spend before any transition counts (location is still other)', () => {
    const {go, set, warnings} = setup(100);
    set(9);                              // before any zone transition
    go(TOWN, MAP);
    expect(warnings()).toHaveLength(1);
    go(MAP, TOWN);
    set(8);
    go(TOWN, MAP);
    expect(warnings().at(-1)?.items).toEqual([{itemId: ITEM, quantity: 8}]);
  });

  it('started in a map: map -> town clears nothing wrongly and the next paid entry is streak 1', () => {
    const {go, set, warnings} = setup(100);
    go(MAP, TOWN);
    set(9);
    go(TOWN, MAP);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].items).toEqual([]);
  });

  it('a spend made inside the map is never a pending spend for the next entry', () => {
    const {go, set, warnings} = setup(100);
    go(TOWN, MAP);
    set(9);                              // in-map spend
    go(MAP, TOWN);
    go(TOWN, MAP);
    expect(warnings().at(-1)?.items).toEqual([]);
  });

  it('map -> hub (spend in hub) -> town -> map: hub spend is not carried; watch decays', () => {
    const {go, set, warnings} = setup(100);
    set(9);
    go(TOWN, MAP);                       // streak 1
    go(MAP, TOWN);
    set(8);
    go(TOWN, MAP);                       // streak 2 -> warned
    expect(warnings().at(-1)?.items).toEqual([{itemId: ITEM, quantity: 8}]);
    go(MAP, SANDLORD_HUB);
    set(7);                              // spend inside the hub
    go(SANDLORD_HUB, TOWN);
    go(TOWN, MAP);                       // no town-side spend: decay
    expect(warnings().at(-1)?.items).toEqual([]);
  });

  it('pending spend in town is cleared by a hub round trip (town -> hub -> town)', () => {
    const {go, set, warnings} = setup(100);
    set(9);
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, TOWN);              // clears pending
    go(TOWN, MAP);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].items).toEqual([]);
    go(MAP, TOWN);
    set(8);
    go(TOWN, MAP);                       // streak is 1 here, not 2
    expect(warnings().at(-1)?.items).toEqual([]);
  });

  it('spends while paused never become pending', () => {
    const {e, go, set, warnings} = setup(100);
    e.pause();
    set(9);
    e.resume();
    go(TOWN, MAP);
    go(MAP, TOWN);
    set(8);
    go(TOWN, MAP);
    expect(warnings().at(-1)?.items).toEqual([]);   // streak 1 only (second entry)
  });
});

describe('zone_change.entering contract (unchanged values)', () => {
  const entering = (events: EngineEvent[]) =>
    events.filter((ev): ev is Extract<EngineEvent, {type: 'zone_change'}> => ev.type === 'zone_change').map(ev => ev.entering);

  it('each scene class reports the pre-1.1 vocabulary', () => {
    const {events, go} = setup();
    go(TOWN, MAP);                       // map
    go(MAP, ARCANA_FIGHT);               // unknown
    go(ARCANA_FIGHT, MAP);               // map
    go(MAP, TARTARUS_FIGHT);             // unknown
    go(TARTARUS_FIGHT, TOWN);            // town
    go(TOWN, VOREX_REWARD);              // unknown
    go(VOREX_REWARD, TOWN);              // town
    go(TOWN, UNKNOWN_SCENE);             // unknown
    go(UNKNOWN_SCENE, TOWN);             // town
    expect(entering(events)).toEqual(['map', 'unknown', 'map', 'unknown', 'town', 'unknown', 'town', 'unknown', 'town']);
  });

  it('the hub and its sub-maps read as map (they matched the map prefixes before)', () => {
    const {events, go} = setup();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    go(SANDLORD_SUB_MAP, SANDLORD_HUB);
    go(SANDLORD_HUB, TOWN);
    expect(entering(events)).toEqual(['map', 'map', 'map', 'town']);
  });

  it('a sub-map after a hub -> fight detour still reads as map', () => {
    const {events, go} = setup();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, ARCANA_FIGHT);
    go(ARCANA_FIGHT, SANDLORD_SUB_MAP);
    expect(entering(events)).toEqual(['map', 'unknown', 'map']);
  });

  it('is emitted while paused and while initializing as well', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    e.start();                           // initializing
    feed(d, e, log.zoneTransition(TOWN, MAP));
    expect(entering(events)).toEqual(['map']);
    feed(d, e, log.bagInit(1, ITEM, 10));
    vi.advanceTimersByTime(600);
    e.pause();
    feed(d, e, log.zoneTransition(MAP, TOWN));
    expect(entering(events)).toEqual(['map', 'town']);
  });
});
