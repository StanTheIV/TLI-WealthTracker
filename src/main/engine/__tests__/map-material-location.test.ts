/**
 * MapMaterialHandler decides "map entry" from ctx.location / ctx.transition.
 * Only a town -> map transition that started a map is a map creation; seasonal
 * scenes and the hub never are.
 *
 * Every map entry emits a `map_material_warning` (possibly empty), so that
 * event count is the observable for "map-entry detection ran".
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TOWN, VOREX_REWARD, TARTARUS_FIGHT,
  boot, createDispatcher, createEngine, feed, log,
} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const ITEM = 100;

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  e.setLowStockThreshold(100); // warn whenever a watched item (streak >= 2) is in the bag
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 10}]);
  let qty = 10;
  const go    = (from: string, to: string) => feed(d, e, log.zoneTransition(from, to));
  const spend = () => { qty -= 1; feed(d, e, log.bagUpdate(1, ITEM, qty)); };
  const warnings = () => events.filter((ev): ev is Extract<EngineEvent, {type: 'map_material_warning'}> => ev.type === 'map_material_warning');
  return {go, spend, warnings};
}

describe('town -> map (characterization, production chain)', () => {
  it('two consecutive paid map entries warn on the watched item', () => {
    const {go, spend, warnings} = setup();

    spend();
    go(TOWN, MAP);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].items).toEqual([]);   // streak 1: not watched yet

    go(MAP, TOWN);
    spend();
    go(TOWN, MAP);
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1].items).toEqual([{itemId: ITEM, quantity: 8}]);
  });
});

describe('seasonal scenes and the hub are not map entries', () => {
  it.each([
    ['arcana fight',  ARCANA_FIGHT],
    ['vorex reward',  VOREX_REWARD],
    ['tartarus fight', TARTARUS_FIGHT],
    ['sandlord hub',  SANDLORD_HUB],
  ])('town -> %s (spend before) runs no map-entry detection', (_name, scene) => {
    const {go, spend, warnings} = setup();

    spend();
    go(TOWN, scene);
    expect(warnings()).toHaveLength(0);

    if (scene === SANDLORD_HUB) {
      go(SANDLORD_HUB, SANDLORD_SUB_MAP);
      expect(warnings()).toHaveLength(0);
    }
    go(scene === SANDLORD_HUB ? SANDLORD_SUB_MAP : scene, TOWN);
    expect(warnings()).toHaveLength(0);

    // Streaks untouched by the detour: the next paid map entry is still the first (streak 1).
    spend();
    go(TOWN, MAP);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].items).toEqual([]);
  });

  it('map -> seasonal scene -> map: no decay, no warning', () => {
    const {go, spend, warnings} = setup();

    spend();
    go(TOWN, MAP);
    go(MAP, TOWN);
    spend();
    go(TOWN, MAP);                       // streak 2, warned
    const before = warnings().length;
    expect(warnings().at(-1)?.items.map(i => i.itemId)).toEqual([ITEM]);

    go(MAP, ARCANA_FIGHT);
    go(ARCANA_FIGHT, MAP);
    expect(warnings()).toHaveLength(before);

    go(MAP, TOWN);
    spend();
    go(TOWN, MAP);                       // streak 3: the watch survived the detour
    expect(warnings().at(-1)?.items.map(i => i.itemId)).toEqual([ITEM]);
  });
});
