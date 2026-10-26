/**
 * ctx.isLootContext() — a pure function of ctx.location — and what it means
 * for crediting: seasonal scenes and the hub are loot, town and other are not.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent, SeasonalType} from '@/shared/contracts/engine';
import {EngineContext, type Location} from '@/main/engine/context';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TARTARUS_FIGHT, TOWN, VOREX_REWARD,
  boot, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {dropsBySource, sessionDrops} from './location-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const ITEM = 800;

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 10}]);
  events.length = 0;
  const line = (l: string) => feed(d, e, l);
  const go   = (from: string, to: string) => line(log.zoneTransition(from, to));
  const bag  = (qty: number) => { line(log.bagUpdate(1, ITEM, qty)); vi.advanceTimersByTime(2_000); };
  return {events, e, line, go, bag};
}

describe('ctx.isLootContext truth table', () => {
  it.each<[Location, boolean]>([
    ['town',           false],
    ['other',          false],
    ['map',            true],
    ['seasonal-scene', true],
    ['hub',            true],
  ])('location %s -> %s', (location, expected) => {
    const c = new EngineContext();
    c.location = location;
    expect(c.isLootContext()).toBe(expected);
  });

  it('a fresh context (location other) is not a loot context', () => {
    expect(new EngineContext().isLootContext()).toBe(false);
  });

  it('does not look at the registry: a live map or seasonal in town changes nothing', () => {
    const c = new EngineContext();
    c.registry.startMap();
    c.registry.startSeasonal({type: 'arcana'}, () => {});
    c.location = 'town';
    expect(c.isLootContext()).toBe(false);
  });
});

describe('seasonal-scene drops reach the right seasonal (characterization)', () => {
  it.each<[SeasonalType, string[], string]>([
    ['arcana',   [log.s9Minigame],                       ARCANA_FIGHT],
    ['vorex',    [log.s13Start],                         VOREX_REWARD],
    ['tartarus', [log.s16BoardOpen, log.s16Suppress],    TARTARUS_FIGHT],
  ])('town-started %s: fight loot -> session, %s only, no map', (type, markers, scene) => {
    const {e, line, go, bag} = setup();
    markers.forEach(line);
    go(TOWN, scene);
    bag(15); // +5 in the fight scene

    expect(sessionDrops(e)).toEqual({[ITEM]: 5});
    expect(dropsBySource(e)).toEqual({[type]: {[ITEM]: 5}});
    expect(ctx(e).registry.seasonal(type)?.snapshot().drops).toEqual({[ITEM]: 5});
    expect(ctx(e).registry.map).toBeNull();
  });
});

describe('hub and its sub-maps (characterization)', () => {
  it('hub and sub-map drops are credited to sandlord, no map tracker', () => {
    const {e, go, bag} = setup();
    go(TOWN, SANDLORD_HUB);
    bag(13);                       // +3 in the hub
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    bag(20);                       // +7 in the sub-map

    expect(sessionDrops(e)).toEqual({[ITEM]: 10});
    expect(dropsBySource(e)).toEqual({sandlord: {[ITEM]: 10}});
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().drops).toEqual({[ITEM]: 10});
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).mapCount).toBe(0);
  });
});

describe('paused hub entry (user decision: the run starts, paused)', () => {
  it('pause -> town -> hub -> resume: loot goes to sandlord, no map is ever created', () => {
    const {events, e, go, bag} = setup();

    e.pause();
    go(TOWN, SANDLORD_HUB);
    e.resume();

    bag(13);                       // +3 in the hub, after resume
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    bag(20);                       // +7 in the sub-map

    expect(ctx(e).mapCount).toBe(0);
    expect(ctx(e).registry.map).toBeNull();
    expect(events.some(ev => ev.type === 'map_started')).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.kind === 'map')).toBe(false);

    const sandlord = ctx(e).registry.seasonal('sandlord');
    expect(sandlord?.phase).toBe('hub');
    expect(sandlord?.active).toBe(true); // resumed with the session
    expect(sandlord?.snapshot().drops).toEqual({[ITEM]: 10});
    expect(sessionDrops(e)).toEqual({[ITEM]: 10});
    expect(dropsBySource(e)).toEqual({sandlord: {[ITEM]: 10}});
  });

  it('the paused hub run is frozen until the resume: no clock, no loot while paused', () => {
    const {e, go} = setup();

    e.pause();
    go(TOWN, SANDLORD_HUB);
    const sandlord = ctx(e).registry.seasonal('sandlord');
    expect(sandlord?.active).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(sandlord?.elapsed()).toBe(0);

    e.resume();
    vi.advanceTimersByTime(4_000);
    expect(sandlord?.elapsed()).toBe(4_000);
  });

  it('pause in a map -> map -> hub -> resume: the map stays frozen for the hub run', () => {
    const {e, go, bag} = setup();
    go(TOWN, MAP);
    bag(12);                       // +2 in the map
    e.pause();
    go(MAP, SANDLORD_HUB);
    e.resume();

    const map = ctx(e).registry.map;
    expect(map?.active).toBe(false);
    bag(15);                       // +3 in the hub: sandlord's, not the frozen map's
    expect(map?.snapshot().drops).toEqual({[ITEM]: 2});
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().drops).toEqual({[ITEM]: 3});
    expect(dropsBySource(e)).toEqual({map: {[ITEM]: 2}, sandlord: {[ITEM]: 3}});

    go(SANDLORD_HUB, TOWN);
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).mapCount).toBe(1);
  });
});
