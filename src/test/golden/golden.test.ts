/**
 * Golden masters: each scenario's log runs through the whole pipeline and its
 * serialised result is pinned in `__snapshots__/<name>.golden.json`. They pin
 * CURRENT behaviour, known bugs included (see each file's `invariants`); a
 * change that moves a number must come with its golden diff, explained.
 * Regenerate with `bunx vitest run src/test/golden -u`.
 *
 * Real fixtures are scrubbed slices of a recorded game log
 * (`bun run replay <log> --lines a:b --extract <file> --scrub`); the
 * synthetic ones are built in `synthetic.ts`.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {describe, expect, it} from 'vitest';
import type {DbSessionMap} from '@/shared/contracts/db';
import {pipelineInvariants, runPipeline, serializeGolden, type PipelineResult} from '../pipeline';
import {GOLDEN_ITEMS} from './items';
import {SYNTHETIC_FIXTURES} from './synthetic';

const REAL_FIXTURES = [
  'plain-map-cost',
  'map-arcana-map',
  'town-panel-then-map',
  'sandlord-hub',
  'sandlord-quench',
] as const;

type Scenario = typeof REAL_FIXTURES[number] | keyof typeof SYNTHETIC_FIXTURES;

const SCENARIOS: Scenario[] = [...REAL_FIXTURES, ...Object.keys(SYNTHETIC_FIXTURES) as Array<keyof typeof SYNTHETIC_FIXTURES>];

function logText(name: Scenario): string {
  return name in SYNTHETIC_FIXTURES
    ? SYNTHETIC_FIXTURES[name as keyof typeof SYNTHETIC_FIXTURES]
    : readFileSync(join(__dirname, 'fixtures', `${name}.log`), 'utf8');
}

// One run per scenario, shared by the snapshot and the structural checks.
// Tests in a file run one at a time, which the replay's global clock requires.
const runs = new Map<Scenario, PipelineResult>();
async function result(name: Scenario): Promise<PipelineResult> {
  let r = runs.get(name);
  if (!r) {
    r = await runPipeline(logText(name), {items: GOLDEN_ITEMS});
    runs.set(name, r);
  }
  return r;
}

async function savedRows(name: Scenario): Promise<DbSessionMap[]> {
  const {sessions} = await result(name);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].session).not.toBeNull();
  return sessions[0].rows;
}

const mapRows = (rows: DbSessionMap[]) => rows.filter(r => r.seasonalType === null);
const seasonal = (rows: DbSessionMap[], type: DbSessionMap['seasonalType']) => rows.filter(r => r.seasonalType === type);

describe('golden masters', () => {
  it.each(SCENARIOS)('%s matches its golden file', async (name) => {
    await expect(serializeGolden(await result(name))).toMatchFileSnapshot(`__snapshots__/${name}.golden.json`);
  });

  it.each(SCENARIOS)('%s: every item is in the table and the run ends in town', async (name) => {
    const {events} = await result(name);
    expect(events.filter(e => e.event.type === 'new_item')).toEqual([]);
    const zones = events.flatMap(e => (e.event.type === 'zone_change' ? [e.event.entering] : []));
    expect(zones.at(-1)).toBe('town');
  });
});

describe('golden accounting invariants', () => {
  it.each(SCENARIOS)('%s: live overlay value and mechanics both reconcile with analytics', async (name) => {
    const invariants = Object.values(pipelineInvariants(await result(name)));
    expect(invariants.length).toBeGreaterThan(0);
    for (const inv of invariants) {
      expect(inv.liveMatchesAnalytics).toEqual({ok: true});
      expect(inv.mechanicsNetReconciles).toEqual({ok: true});
    }
  });
});

describe('golden scenario shapes', () => {
  it('plain-map-cost: one map, its entry cost on the map row', async () => {
    const rows = await savedRows('plain-map-cost');
    expect(mapRows(rows)).toHaveLength(1);
    expect(Object.keys(mapRows(rows)[0].spent).length).toBeGreaterThan(0);
  });

  it('map-arcana-map: the Arcana run is an overlap of the map it interrupted', async () => {
    const rows = await savedRows('map-arcana-map');
    const [map] = mapRows(rows);
    expect(mapRows(rows)).toHaveLength(1);
    expect(seasonal(rows, 'arcana')).toEqual([expect.objectContaining({parentMapIndex: map.mapIndex})]);
  });

  it('town-panel-then-map: the town-opened Arcana run is standalone, before the next map', async () => {
    const rows = await savedRows('town-panel-then-map');
    const [arcana] = seasonal(rows, 'arcana');
    expect(arcana.parentMapIndex).toBeNull();
    expect(mapRows(rows).some(m => m.mapIndex > arcana.mapIndex)).toBe(true);
  });

  it('sandlord-hub: one standalone hub run; its sub-maps are not maps', async () => {
    const rows = await savedRows('sandlord-hub');
    const {sessions} = await result('sandlord-hub');
    expect(seasonal(rows, 'sandlord').filter(r => r.phase === 'hub')).toEqual([expect.objectContaining({parentMapIndex: null})]);
    expect(sessions[0].session!.mapCount).toBe(mapRows(rows).length);
  });

  it('sandlord-quench: the coin tile is an in-map run of the map', async () => {
    const rows = await savedRows('sandlord-quench');
    const [map] = mapRows(rows);
    expect(seasonal(rows, 'sandlord')).toEqual([expect.objectContaining({phase: 'map', parentMapIndex: map.mapIndex})]);
  });

  // 1.4: a loot window armed on a dormant tracker wakes it, so the terminal
  // window's drops credit the seasonal (single owner) instead of the map.
  it('sandlord-quench: the quench wakes the dormant tile, so its window credits the run', async () => {
    const rows = await savedRows('sandlord-quench');
    const {sessions} = await result('sandlord-quench');
    const [tile] = seasonal(rows, 'sandlord');
    expect(tile.duration).toBe(25_000);
    expect(tile.drops).toEqual({'5028': 1, '100200': 9, '100300': 2});
    const bySource = sessions[0].session!.dropsBySource;
    expect(bySource.sandlord?.['5028']).toBe(1);
    expect(bySource.map?.['5028']).toBe(14);
  });

  it('afterlight-special-no-win: the Special Stop wakes the dormant run and credits its window', async () => {
    const rows = await savedRows('afterlight-special-no-win');
    const {sessions} = await result('afterlight-special-no-win');
    const [run] = seasonal(rows, 'afterlight');
    expect(run.duration).toBe(20_000);
    expect(run.drops).toEqual({'5210': 4, '6153': 1, '100300': 35});
    const bySource = sessions[0].session!.dropsBySource;
    expect(bySource.afterlight).toMatchObject({'6153': 1, '100300': 35});
    expect(bySource.map?.['6153']).toBe(1);
    expect(bySource.map?.['100300']).toBe(12);
  });

  it('carjack-stop-after-dormancy: the Stop wakes the dormant run and credits its window', async () => {
    const rows = await savedRows('carjack-stop-after-dormancy');
    const {sessions} = await result('carjack-stop-after-dormancy');
    const [run] = seasonal(rows, 'carjack');
    expect(run.duration).toBe(21_000);
    expect(run.drops).toEqual({'5210': 3, '6004': 2, '100300': 35});
    const bySource = sessions[0].session!.dropsBySource;
    expect(bySource.carjack).toMatchObject({'6004': 2, '100300': 35});
    expect(bySource.map?.['6004']).toBeUndefined();
    expect(bySource.map?.['100300']).toBe(12);
  });

  it.each([
    ['map-vorex', 'vorex'],
    ['afterlight-special-no-win', 'afterlight'],
    ['carjack-stop-after-dormancy', 'carjack'],
  ] as const)('%s: one map with one %s run', async (name, type) => {
    const rows = await savedRows(name);
    expect(mapRows(rows)).toHaveLength(1);
    expect(seasonal(rows, type)).toHaveLength(1);
  });
});
