import {readdirSync, readFileSync} from 'fs';
import {join} from 'path';
import {describe, expect, it} from 'vitest';

const DIR = join(__dirname, '__snapshots__');
const files = readdirSync(DIR).filter(f => f.endsWith('.golden.json'));

describe('every golden ends its event list with exactly one engine_stopped', () => {
  it('finds the goldens', () => { expect(files.length).toBeGreaterThanOrEqual(11); });

  for (const f of files) {
    it(f, () => {
      const g = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as {events: {counts: Record<string, number>; lines?: string[]}};
      expect(g.events.counts.engine_stopped).toBe(1);
      const lines = Object.entries(g.events).find(([k, v]) => k !== 'counts' && Array.isArray(v))?.[1] as string[];
      const stops = lines.filter(l => l.endsWith(' engine_stopped'));
      expect(stops).toHaveLength(1);
      expect(lines[lines.length - 1]).toMatch(/ engine_stopped$/);
      // ...straight after the session tracker_finished
      expect(lines[lines.length - 2]).toMatch(/tracker_finished session /);
    });
  }
});
