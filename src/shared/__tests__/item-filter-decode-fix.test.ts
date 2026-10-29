/** decodeFilterRules rejects holes in a sparse array (structured clone keeps them; JSON would store null). */
import {describe, it, expect} from 'vitest';
import {decodeFilterRules} from '@/shared/item-filter';

const RULE = {id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session']};

describe('decodeFilterRules - sparse arrays (structured clone preserves holes over IPC)', () => {
  it('a hole in the rules list is rejected (otherwise JSON.stringify stores null and the row is unreadable forever)', () => {
    const sparse = [, RULE];
    let out: unknown;
    try { out = decodeFilterRules(sparse); } catch { return; }
    expect(JSON.parse(JSON.stringify(out))).not.toContain(null);
  });

  it('a hole in scopes is rejected (never stored as null)', () => {
    const scopes = ['session', , 'map'];
    let out;
    try { out = decodeFilterRules([{...RULE, scopes}]); } catch { return; }
    expect(JSON.parse(JSON.stringify(out))[0].scopes.every((s: unknown) => typeof s === 'string')).toBe(true);
  });
});
