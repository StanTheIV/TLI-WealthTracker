import {describe, expect, it} from 'vitest';
import {MECHANICS, isMapFreezing, mechanic, parsePositiveInt, windowMs} from '@/shared/mechanics';
import {FILTER_SCOPES} from '@/shared/item-filter';
import {
  ARCANA_FIGHT_SCENE, SANDLORD_HUB_SCENE, SEASONAL_SCENE_MARKERS, TARTARUS_PRISON_SCENE, TOWN_SCENE,
  VOREX_REWARD_SCENE,
} from '@/shared/scenes';
import type {SeasonalType} from '@/shared/contracts/engine';
import {MAP_FREEZING_SEASONALS, runsConcurrentlyWithMap} from '@/domain/session-analytics/attribution';

const keys = MECHANICS.map(m => m.key);

describe('MECHANICS table', () => {
  it('one row per SeasonalType, in SeasonalType order', () => {
    // A Record over SeasonalType fails to compile if a member is missing or extra.
    const every: Record<SeasonalType, true> = {
      vorex: true, dream: true, overrealm: true, carjack: true, clockwork: true, sandlord: true,
      lunaria: true, arcana: true, hunting: true, afterlight: true, tartarus: true,
    };
    expect(keys).toEqual(Object.keys(every));
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(mechanic(k).key).toBe(k);
  });

  it('FILTER_SCOPES keeps its exact chip order', () => {
    expect(FILTER_SCOPES).toEqual([
      'session', 'map', 'vorex', 'dream', 'overrealm', 'carjack', 'clockwork', 'sandlord',
      'lunaria', 'arcana', 'hunting', 'afterlight', 'tartarus', 'wealth',
    ]);
  });

  it('categories: three interludes, sandlord phased, the rest in-map', () => {
    expect(MECHANICS.filter(m => m.category === 'interlude').map(m => m.key).sort())
      .toEqual(['arcana', 'tartarus', 'vorex']);
    expect(mechanic('sandlord').category).toEqual({map: 'in-map', hub: 'own-area'});
    expect(MECHANICS.filter(m => m.category === 'in-map').map(m => m.key).sort())
      .toEqual(['afterlight', 'carjack', 'clockwork', 'dream', 'hunting', 'lunaria', 'overrealm']);
  });

  it('windows: 5000 ms loot ×6, the sandlord wave 10000 ms, none for the rest', () => {
    const windows = Object.fromEntries(MECHANICS.map(m => [m.key, m.window]));
    expect(windows).toEqual({
      vorex:      null,
      dream:      null,
      overrealm:  {settingKey: 'overrealmLootMs',  defaultMs: 5_000,  kind: 'loot'},
      carjack:    {settingKey: 'carjackLootMs',    defaultMs: 5_000,  kind: 'loot'},
      clockwork:  {settingKey: 'clockworkLootMs',  defaultMs: 5_000,  kind: 'loot'},
      sandlord:   {settingKey: 'sandlordWaveMs',   defaultMs: 10_000, kind: 'wave'},
      lunaria:    {settingKey: 'lunariaLootMs',    defaultMs: 5_000,  kind: 'loot'},
      arcana:     null,
      hunting:    {settingKey: 'huntingLootMs',    defaultMs: 5_000,  kind: 'loot'},
      afterlight: {settingKey: 'afterlightLootMs', defaultMs: 5_000,  kind: 'loot'},
      tartarus:   null,
    });
  });

  it('setting keys are unique and never collide with the low-stock key', () => {
    const settingKeys = MECHANICS.flatMap(m => (m.window ? [m.window.settingKey] : []));
    expect(new Set(settingKeys).size).toBe(settingKeys.length);
    expect(settingKeys).not.toContain('lowStockThreshold');
  });
});

describe('scene markers derived from the table', () => {
  it('pins the derived constants', () => {
    expect(ARCANA_FIGHT_SCENE).toBe('SuMingTaLuo');
    expect(VOREX_REWARD_SCENE).toBe('DiXiaZhenSuo');
    expect(TARTARUS_PRISON_SCENE).toBe('ZhongZuiDiYu');
    expect(SANDLORD_HUB_SCENE).toBe('YunDuanLvZhou');
  });

  it('SEASONAL_SCENE_MARKERS are exactly the interludes\' fight scenes', () => {
    expect([...SEASONAL_SCENE_MARKERS].sort()).toEqual(['DiXiaZhenSuo', 'SuMingTaLuo', 'ZhongZuiDiYu']);
    const interludeScenes = MECHANICS.flatMap(m =>
      (m.category === 'interlude' && 'fightScene' in m ? [m.fightScene] : []));
    expect([...SEASONAL_SCENE_MARKERS].sort()).toEqual(interludeScenes.sort());
  });

  it('every scene marker is unique and none is a substring of another', () => {
    // ZoneHandler matches by substring, town first: an overlap would misclassify.
    const scenes = [
      TOWN_SCENE,
      ...MECHANICS.flatMap(m => ('fightScene' in m ? [m.fightScene] : [])),
      ...MECHANICS.flatMap(m => ('hubScene' in m ? [m.hubScene] : [])),
    ];
    expect(scenes).toHaveLength(5);
    expect(new Set(scenes).size).toBe(scenes.length);
    for (const a of scenes) {
      for (const b of scenes) {
        if (a !== b) expect(b.includes(a), `${a} inside ${b}`).toBe(false);
      }
    }
  });
});

describe('map freezing derived from the table', () => {
  it('MAP_FREEZING_SEASONALS is arcana, vorex, tartarus, sandlord', () => {
    expect([...MAP_FREEZING_SEASONALS].sort()).toEqual(['arcana', 'sandlord', 'tartarus', 'vorex']);
  });

  it('classifies every type and phase as before', () => {
    for (const type of keys) {
      const interlude = type === 'arcana' || type === 'vorex' || type === 'tartarus';
      for (const phase of ['map', 'hub', null] as const) {
        const freezes = interlude || (type === 'sandlord' && phase !== 'map');
        expect(isMapFreezing(type, phase), `${type}/${phase}`).toBe(freezes);
        expect(runsConcurrentlyWithMap(type, phase), `${type}/${phase}`).toBe(!freezes);
      }
    }
    expect(runsConcurrentlyWithMap(null)).toBe(false);
    expect(runsConcurrentlyWithMap('sandlord')).toBe(false);    // null phase = legacy hub
  });

  it('an unknown type (a legacy row) freezes nothing', () => {
    expect(isMapFreezing('nope' as SeasonalType, null)).toBe(false);
    expect(runsConcurrentlyWithMap('nope' as SeasonalType)).toBe(true);
  });
});

describe('setting parse', () => {
  it.each([
    [undefined, 5_000], ['', 5_000], ['0', 5_000], ['-5', 5_000], ['abc', 5_000], ['0.5', 5_000],
    ['Infinity', 5_000], ['NaN', 5_000], ['7000', 7_000], ['7000.9', 7_000], [' 7000 ', 7_000], ['1', 1],
  ])('window %j → %d', (raw, ms) => {
    expect(windowMs(raw === undefined ? {} : {carjackLootMs: raw}, mechanic('carjack'))).toBe(ms);
  });

  it('allowZero accepts 0 and still rejects negatives', () => {
    expect(parsePositiveInt('0', 9, true)).toBe(0);
    expect(parsePositiveInt('0.5', 9, true)).toBe(0);
    expect(parsePositiveInt('-1', 9, true)).toBe(9);
    expect(parsePositiveInt('-0.5', 9, true)).toBe(9);
    expect(parsePositiveInt('abc', 9, true)).toBe(9);
    expect(parsePositiveInt(undefined, 9, true)).toBe(9);
    expect(parsePositiveInt('3.7', 9, true)).toBe(3);
  });
});
