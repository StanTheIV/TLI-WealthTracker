/**
 * Every golden scenario's event stream through the owner-publishing invariant
 * (see src/test/owner-invariant.ts): boolean owner on every seasonal snapshot,
 * none on map/session, no redundant seasonal update, at most one published
 * owner at every settled point, the renderer store in step, nothing left
 * published once the run is over.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {describe, expect, it} from 'vitest';
import {runPipeline} from '../pipeline';
import {OwnerWatcher, settledIndexes} from '../owner-invariant';
import {GOLDEN_ITEMS} from './items';
import {SYNTHETIC_FIXTURES} from './synthetic';

const REAL_FIXTURES = ['plain-map-cost', 'map-arcana-map', 'town-panel-then-map', 'sandlord-hub', 'sandlord-quench'] as const;
const SCENARIOS = [...REAL_FIXTURES, ...Object.keys(SYNTHETIC_FIXTURES)];

function logText(name: string): string {
  return name in SYNTHETIC_FIXTURES
    ? SYNTHETIC_FIXTURES[name as keyof typeof SYNTHETIC_FIXTURES]
    : readFileSync(join(__dirname, 'fixtures', `${name}.log`), 'utf8');
}

describe('golden events satisfy the owner-publishing invariant', () => {
  it.each(SCENARIOS)('%s', async (name) => {
    const {events} = await runPipeline(logText(name), {items: GOLDEN_ITEMS});
    const all     = events.map(e => e.event);
    const settled = settledIndexes(all);
    const w       = new OwnerWatcher({store: true});
    all.forEach((ev, i) => {
      w.onEmit(ev);
      if (settled.has(i)) w.checkSet(`event ${i} ${ev.type}`);
    });
    expect(w.violations).toEqual([]);
    expect(all.some(ev => ev.type === 'tracker_started' && ev.tracker.kind === 'seasonal')).toBe(true);
    expect(w.published.size).toBe(0);
  });
});
