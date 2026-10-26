/**
 * All golden scenarios through the unit invariant and the saved-row invariants,
 * via runPipeline (dispatcher -> engine -> SessionPersistence -> SQLite).
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {describe, expect, it} from 'vitest';
import {runPipeline} from '../pipeline';
import {GOLDEN_ITEMS} from '../golden/items';
import {SYNTHETIC_FIXTURES} from '../golden/synthetic';
import {checkUnits, countUnitRuns} from '../unit-invariant';

const REAL = ['plain-map-cost', 'map-arcana-map', 'town-panel-then-map', 'sandlord-hub', 'sandlord-quench'] as const;
const SCENARIOS = [...REAL, ...Object.keys(SYNTHETIC_FIXTURES)] as string[];

const text = (name: string): string =>
  name in SYNTHETIC_FIXTURES
    ? SYNTHETIC_FIXTURES[name as keyof typeof SYNTHETIC_FIXTURES]
    : readFileSync(join(__dirname, '..', 'golden', 'fixtures', `${name}.log`), 'utf8');

describe('goldens through the unit invariant', () => {
  it('covers all 11 scenarios', () => {
    expect(SCENARIOS).toHaveLength(11);
  });

  it.each(SCENARIOS)('%s: unit stream and saved rows hold the invariants', async (name) => {
    const r = await runPipeline(text(name), {items: GOLDEN_ITEMS});
    const events = r.events.map(e => e.event);
    expect(checkUnits(events)).toEqual([]);
    expect(events.some(e => e.type === 'unit_finished')).toBe(true);

    expect(r.sessions).toHaveLength(1);
    const rows = r.sessions[0].rows;
    expect(rows).toHaveLength(countUnitRuns(events));

    const primaries = rows.filter(x => x.parentMapIndex === null);
    expect(primaries.map(x => x.mapIndex)).toEqual(primaries.map((_, i) => i + 1));
    for (const row of rows) {
      expect(row.endedAt).toBeGreaterThanOrEqual(row.startedAt + row.duration);
      if (row.parentMapIndex === null) continue;
      const parent = primaries.find(p => p.mapIndex === row.parentMapIndex)!;
      expect(row.mapIndex).toBe(row.parentMapIndex);
      expect(parent.seasonalType).toBeNull();
      expect(row.startedAt).toBeLessThanOrEqual(parent.endedAt);
      expect(row.endedAt).toBeLessThanOrEqual(parent.endedAt);
    }
  });
});
