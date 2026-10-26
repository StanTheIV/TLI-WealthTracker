/**
 * End to end (dispatcher -> engine -> SessionPersistence -> SQLite): the saved
 * rows of the five unit shapes, plus the `unit_finished` events behind them.
 * `town-arcana-backout-then-map` and `map-hub-direct` are also pinned as golden
 * scenarios; the other three are built here. Reset is covered at engine level
 * (map-units.test.ts): the replay has no reset control.
 */
import {describe, expect, it} from 'vitest';
import type {DbSessionMap} from '@/shared/contracts/db';
import {runPipeline, type PipelineResult} from '../pipeline';
import {GOLDEN_ITEMS} from '../golden/items';
import {
  ARCANA_FIGHT, ARCANA_LEVEL, BODY, COMPASS, CUBE, FE, MAP, MATERIAL, PROBE, RARE_CARD,
  Script, SYNTHETIC_FIXTURES, TOWN, TOWN_LEVEL,
} from '../golden/synthetic';
import {unitsOf} from '../unit-events';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0, 0);

const run = (text: string, controls?: Array<{at: number; op: 'start' | 'pause' | 'resume' | 'stop'}>) =>
  runPipeline(text, {items: GOLDEN_ITEMS, controls});

const shape = (rows: DbSessionMap[]) =>
  rows.map(({mapIndex, parentMapIndex, seasonalType, phase}) => ({mapIndex, parentMapIndex, seasonalType, phase}));

const units = (r: PipelineResult) => unitsOf(r.events.map(e => e.event));
const unitKinds = (r: PipelineResult) => units(r).map(u => (u.tracker.kind === 'map' ? 'map' : `seasonal:${u.tracker.seasonalType}`));

const townDump = () => new Script().dump(0, [[FE, 500], [COMPASS, 10], [PROBE, 5], [MATERIAL, 50], [CUBE, 20]]);

describe('town-arcana-backout-then-map', () => {
  it('the dormant arcana is a standalone row ahead of the map row', async () => {
    const r = await run(SYNTHETIC_FIXTURES['town-arcana-backout-then-map']);

    expect(shape(r.sessions[0].rows)).toEqual([
      {mapIndex: 1, parentMapIndex: null, seasonalType: 'arcana', phase: null},
      {mapIndex: 2, parentMapIndex: null, seasonalType: null,     phase: null},
    ]);
    expect(unitKinds(r)).toEqual(['seasonal:arcana', 'map']);
    expect(units(r).map(u => u.overlaps.length)).toEqual([0, 0]);
  });
});

describe('town-arcana-reopened-in-map', () => {
  const text = townDump()
    .line(10, BODY.s9Minigame)
    .line(14, BODY.s9Close)
    .bag(25, COMPASS, -1)
    .zone(26, TOWN, MAP, [5318, 3])
    .bag(30, FE, 12)
    .line(35, BODY.s9Minigame)           // reopened inside the map: it wakes, the map freezes
    .line(40, BODY.s9Close)
    .bag(45, RARE_CARD, 1)
    .zone(60, MAP, TOWN, TOWN_LEVEL)
    .text();

  it('the arcana is an overlap of that map', async () => {
    const r = await run(text);

    expect(shape(r.sessions[0].rows)).toEqual([
      {mapIndex: 1, parentMapIndex: null, seasonalType: null,     phase: null},
      {mapIndex: 1, parentMapIndex: 1,    seasonalType: 'arcana', phase: null},
    ]);
    expect(unitKinds(r)).toEqual(['map']);
    expect(units(r)[0].overlaps.map(o => o.tracker.seasonalType)).toEqual(['arcana']);
  });

  it('with a fight from the map in between, still one map unit with one arcana child', async () => {
    const withFight = townDump()
      .line(10, BODY.s9Minigame)
      .bag(25, COMPASS, -1)
      .zone(26, TOWN, MAP, [5318, 3])
      .line(35, BODY.s9Minigame)
      .zone(40, MAP, ARCANA_FIGHT, ARCANA_LEVEL)
      .bag(45, FE, 12)
      .zone(55, ARCANA_FIGHT, MAP, [5318, 3])
      .zone(70, MAP, TOWN, TOWN_LEVEL)
      .text();
    const r = await run(withFight);

    expect(shape(r.sessions[0].rows)).toEqual([
      {mapIndex: 1, parentMapIndex: null, seasonalType: null,     phase: null},
      {mapIndex: 1, parentMapIndex: 1,    seasonalType: 'arcana', phase: null},
    ]);
    expect(unitKinds(r)).toEqual(['map']);
  });
});

describe('map-hub-direct', () => {
  it('the hub run is an overlap of the frozen map, phase hub', async () => {
    const r = await run(SYNTHETIC_FIXTURES['map-hub-direct']);

    expect(shape(r.sessions[0].rows)).toEqual([
      {mapIndex: 1, parentMapIndex: null, seasonalType: null,       phase: null},
      {mapIndex: 1, parentMapIndex: 1,    seasonalType: 'sandlord', phase: 'hub'},
    ]);
    expect(unitKinds(r)).toEqual(['map']);
    expect(units(r)[0].overlaps[0].tracker.phase).toBe('hub');
  });
});

describe('stop-mid-map', () => {
  // The Arcana fight from the map ends (child finished, waiting for its map);
  // the session is stopped while the map is still live.
  const text = townDump()
    .bag(25, COMPASS, -1)
    .zone(26, TOWN, MAP, [5318, 3])
    .bag(30, FE, 12)
    .line(35, BODY.s9Minigame)
    .zone(40, MAP, ARCANA_FIGHT, ARCANA_LEVEL)
    .bag(45, FE, 12)
    .bag(46, CUBE, 2)
    .zone(55, ARCANA_FIGHT, MAP, [5318, 3])
    .bag(60, FE, 5)
    .zone(90, MAP, TOWN, TOWN_LEVEL)
    .text();

  it('the finished child is saved as a standalone row; the live map is dropped', async () => {
    const r = await run(text, [{at: T0 + 65_000, op: 'stop'}]);

    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].session).not.toBeNull();
    expect(shape(r.sessions[0].rows)).toEqual([
      {mapIndex: 1, parentMapIndex: null, seasonalType: 'arcana', phase: null},
    ]);
  });

  it('the child is emitted as a standalone unit before the session tracker_finished', async () => {
    const r = await run(text, [{at: T0 + 65_000, op: 'stop'}]);
    const types = r.events.map(e => (e.event as {type: string}).type);

    expect(unitKinds(r)).toEqual(['seasonal:arcana']);
    expect(units(r)[0].overlaps).toEqual([]);
    expect(types.indexOf('unit_finished')).toBeGreaterThanOrEqual(0);
    const sessionFinished = r.events.findIndex(e => e.event.type === 'tracker_finished' && e.event.tracker.kind === 'session');
    expect(types.indexOf('unit_finished')).toBeLessThan(sessionFinished);
  });

  it('a stop with no finished child saves no rows and emits no unit', async () => {
    const r = await run(text, [{at: T0 + 36_000, op: 'stop'}]);

    expect(units(r)).toEqual([]);
    expect(r.sessions[0].rows).toEqual([]);
  });
});

describe('the units of the existing synthetic scenarios', () => {
  it('map-vorex: one map unit, the vorex run its overlap', async () => {
    const r = await run(SYNTHETIC_FIXTURES['map-vorex']);
    expect(unitKinds(r)).toEqual(['map']);
    expect(units(r)[0].overlaps.map(o => o.tracker.seasonalType)).toEqual(['vorex']);
  });

  it('town-panel-activity: the town-only arcana is a standalone unit and no map unit exists', async () => {
    const r = await run(SYNTHETIC_FIXTURES['town-panel-activity']);
    expect(unitKinds(r)).toEqual(['seasonal:arcana']);
  });
});
