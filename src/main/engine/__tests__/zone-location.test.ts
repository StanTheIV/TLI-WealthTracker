/**
 * ctx.location / prevLocation / transition — written by ZoneHandler on every
 * zone_transition. The `zone_change.entering` cases pin the renderer-facing
 * values, which the location model must not change.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {EmitFn} from '@/main/engine/types';
import {EngineContext, type Location} from '@/main/engine/context';
import {ZoneHandler} from '@/main/engine/handlers/zone';
import {
  TEST_IDENTITY,
  ARCANA_FIGHT, MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TARTARUS_FIGHT, TOWN, VOREX_REWARD,
  boot, createDispatcher, createEngine, ctx, feed, internalEmit, log,
} from './seasonal-fixtures';
import {UNKNOWN_SCENE} from './location-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const INVENTORY = [{slotId: 1, itemId: 200, quantity: 10}];

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, INVENTORY);
  const go = (from: string, to: string) => feed(d, e, log.zoneTransition(from, to));
  return {events, d, e, go};
}

describe('ctx.location — real engine chain', () => {
  it('town -> map: location map, prev town, mapStarted', () => {
    const {e, go} = setup();
    go(TOWN, MAP);

    const c = ctx(e);
    expect(c.location).toBe('map');
    expect(c.prevLocation).toBe('town');
    expect(c.transition).toEqual({from: 'town', to: 'map', mapStarted: true});
    expect(ctx(e).inMap).toBe(true);
  });

  it('map -> town: location town, prev map, no map started', () => {
    const {e, go} = setup();
    go(TOWN, MAP);
    go(MAP, TOWN);

    const c = ctx(e);
    expect(c.location).toBe('town');
    expect(c.prevLocation).toBe('map');
    expect(c.transition).toEqual({from: 'map', to: 'town', mapStarted: false});
    expect(ctx(e).inMap).toBe(false);
  });

  it('map -> seasonal scene -> map: mapStarted false both ways, mapCount stays 1', () => {
    const {e, go} = setup();
    go(TOWN, MAP);

    go(MAP, ARCANA_FIGHT);
    expect(ctx(e).location).toBe('seasonal-scene');
    expect(ctx(e).transition).toEqual({from: 'map', to: 'seasonal-scene', mapStarted: false});
    expect(ctx(e).inMap).toBe(true);

    go(ARCANA_FIGHT, MAP);
    expect(ctx(e).location).toBe('map');
    expect(ctx(e).prevLocation).toBe('seasonal-scene');
    expect(ctx(e).transition).toEqual({from: 'seasonal-scene', to: 'map', mapStarted: false});
    expect(ctx(e).mapCount).toBe(1);
  });

  it.each([
    ['arcana fight',   ARCANA_FIGHT],
    ['vorex reward',   VOREX_REWARD],
    ['tartarus fight', TARTARUS_FIGHT],
  ])('town -> %s: seasonal-scene, no map', (_name, scene) => {
    const {e, go} = setup();
    go(TOWN, scene);

    const c = ctx(e);
    expect(c.location).toBe('seasonal-scene');
    expect(c.prevLocation).toBe('town');
    expect(c.transition).toEqual({from: 'town', to: 'seasonal-scene', mapStarted: false});
    expect(ctx(e).inMap).toBe(false);
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).mapCount).toBe(0);
  });

  it('town -> hub: hub, no map started', () => {
    const {e, go} = setup();
    go(TOWN, SANDLORD_HUB);

    const c = ctx(e);
    expect(c.location).toBe('hub');
    expect(c.prevLocation).toBe('town');
    expect(c.transition).toEqual({from: 'town', to: 'hub', mapStarted: false});
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).mapCount).toBe(0);
  });

  it('hub -> sub-map stays hub (sticky) and starts no map; sub-map -> hub too', () => {
    const {e, go} = setup();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);

    expect(ctx(e).location).toBe('hub');
    expect(ctx(e).prevLocation).toBe('hub');
    expect(ctx(e).transition).toEqual({from: 'hub', to: 'hub', mapStarted: false});
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).mapCount).toBe(0);

    go(SANDLORD_SUB_MAP, SANDLORD_HUB);
    expect(ctx(e).transition).toEqual({from: 'hub', to: 'hub', mapStarted: false});
    expect(ctx(e).mapCount).toBe(0);
  });

  it('hub -> town and sub-map -> town: town, prev hub', () => {
    const {e, go} = setup();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    go(SANDLORD_SUB_MAP, TOWN);

    expect(ctx(e).location).toBe('town');
    expect(ctx(e).prevLocation).toBe('hub');
    expect(ctx(e).transition).toEqual({from: 'hub', to: 'town', mapStarted: false});
  });

  it('map -> hub: hub, map frozen but inMap stays true', () => {
    const {e, go} = setup();
    go(TOWN, MAP);
    go(MAP, SANDLORD_HUB);

    const c = ctx(e);
    expect(c.location).toBe('hub');
    expect(c.prevLocation).toBe('map');
    expect(c.transition).toEqual({from: 'map', to: 'hub', mapStarted: false});
    expect(ctx(e).inMap).toBe(true);
    expect(ctx(e).registry.map?.active).toBe(false);
    expect(ctx(e).mapCount).toBe(1);

    go(SANDLORD_HUB, SANDLORD_SUB_MAP); // sub-map under the hub: still the hub, no second map
    expect(ctx(e).location).toBe('hub');
    expect(ctx(e).mapCount).toBe(1);
  });

  it('Engine.reset() mid-map keeps location map', () => {
    const {e, go} = setup();
    go(TOWN, MAP);
    e.reset(TEST_IDENTITY);

    expect(ctx(e).inMap).toBe(true);
    expect(ctx(e).location).toBe('map');
    expect(ctx(e).prevLocation).toBe('town');
  });

  it('an unrecognised scene is other, and not a loot context', () => {
    const {e, go} = setup();
    go(TOWN, UNKNOWN_SCENE);

    expect(ctx(e).location).toBe('other');
    expect(ctx(e).transition).toEqual({from: 'town', to: 'other', mapStarted: false});
    expect(ctx(e).isLootContext()).toBe(false);
    expect(ctx(e).registry.map).toBeNull();
  });

  it.each<[string, string, string, Location, Location]>([
    ['town -> map',          TOWN,          MAP,  'town',           'map'],
    ['map -> town',          MAP,           TOWN, 'map',            'town'],
    ['hub -> town',          SANDLORD_HUB,  TOWN, 'hub',            'town'],
    ['arcana fight -> town', ARCANA_FIGHT,  TOWN, 'seasonal-scene', 'town'],
    ['unknown -> town',      UNKNOWN_SCENE, TOWN, 'other',          'town'],
  ])('the first transition after start derives `from` from the scene: %s', (_n, from, to, wantFrom, wantTo) => {
    const {e, go} = setup();
    expect(ctx(e).location).toBe('other'); // the initial value
    go(from, to);

    expect(ctx(e).transition).toMatchObject({from: wantFrom, to: wantTo});
    expect(ctx(e).prevLocation).toBe(wantFrom);
    expect(ctx(e).location).toBe(wantTo);
  });
});

describe('ctx.location — ZoneHandler alone (no phase / pause gating)', () => {
  const emit: EmitFn = () => {};
  const fire = (c: EngineContext, from: string, to: string) =>
    new ZoneHandler().handle({type: 'zone_transition', fromScene: from, toScene: to}, c, emit);

  it('is updated while initializing', () => {
    const c = new EngineContext();
    c.phase = 'initializing';
    fire(c, TOWN, MAP);

    expect(c.location).toBe('map');
    expect(c.prevLocation).toBe('town');
    expect(c.transition?.from).toBe('town');
    expect(c.transition?.to).toBe('map');
  });

  it('is updated while paused', () => {
    const c = new EngineContext();
    c.phase  = 'tracking';
    c.paused = true;
    fire(c, TOWN, MAP);
    expect(c.location).toBe('map');
    expect(c.transition).toEqual({from: 'town', to: 'map', mapStarted: true});

    fire(c, MAP, TOWN);
    expect(c.location).toBe('town');
    expect(c.prevLocation).toBe('map');
  });

  it('the hub is detected by scene name alone, without a bubble in the registry', () => {
    const c = new EngineContext();
    c.phase = 'tracking';
    fire(c, TOWN, SANDLORD_HUB);

    expect(c.location).toBe('hub');
    expect(c.inMap).toBe(false);
    expect(c.registry.map).toBeNull();
    expect(c.mapCount).toBe(0);

    fire(c, SANDLORD_HUB, SANDLORD_SUB_MAP);
    expect(c.location).toBe('hub');
    expect(c.mapCount).toBe(0);
  });
});

describe('zone_change.entering (characterization — values must not change in 1.1)', () => {
  it.each([
    ['town',               TOWN,             'town'],
    ['map',                MAP,              'map'],
    ['hub',                SANDLORD_HUB,     'map'],
    ['hub sub-map',        SANDLORD_SUB_MAP, 'map'],
    ['arcana fight',       ARCANA_FIGHT,     'unknown'],
    ['vorex reward',       VOREX_REWARD,     'unknown'],
    ['tartarus fight',     TARTARUS_FIGHT,   'unknown'],
    ['unrecognised scene', UNKNOWN_SCENE,    'unknown'],
  ])('%s -> entering %s', (_name, scene, entering) => {
    const events: EngineEvent[] = [];
    const c = new EngineContext();
    c.phase = 'tracking';
    new ZoneHandler().handle({type: 'zone_transition', fromScene: 'XZ_Elsewhere', toScene: scene}, c, internalEmit(e => { events.push(e); }));

    expect(events.find(ev => ev.type === 'zone_change')).toMatchObject({entering});
  });
});
