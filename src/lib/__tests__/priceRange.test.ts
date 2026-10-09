import {describe, expect, it} from 'vitest';
import {leagueRanges} from '../leagues';
import {availablePresets, defaultPreset, resolvePriceRange} from '../priceRange';

const DAY = 86_400_000;
const ranges = leagueRanges([
  {id: 'A', name: 'A', startsAt: 1000, source: 'bundled'},
  {id: 'B', name: 'B', startsAt: 5000, source: 'bundled'},
]);

describe('resolvePriceRange', () => {
  it('current league is open-ended up to now', () => {
    expect(resolvePriceRange('league', ranges, 9000)).toEqual({from: 5000, to: 9001});
  });
  it('caps at now when the next league is already announced (future start)', () => {
    const r = leagueRanges([
      {id: 'A', name: 'A', startsAt: 1000, source: 'bundled'},
      {id: 'B', name: 'B', startsAt: 5000, source: 'bundled'},
    ]);
    expect(resolvePriceRange('league', r, 3000)).toEqual({from: 1000, to: 3001});
  });
  it('previous league ends where the current begins', () => {
    expect(resolvePriceRange('prevLeague', ranges, 9000)).toEqual({from: 1000, to: 5000});
  });
  it('previous league is unavailable in the first league', () => {
    expect(resolvePriceRange('prevLeague', ranges, 2000)).toBeNull();
  });
  it('all / 7d / 1d', () => {
    expect(resolvePriceRange('all', ranges, 9000)).toEqual({from: 0, to: 9001});
    expect(resolvePriceRange('7d', ranges, 10 * DAY)).toEqual({from: 3 * DAY, to: 10 * DAY + 1});
    expect(resolvePriceRange('1d', ranges, 10 * DAY)).toEqual({from: 9 * DAY, to: 10 * DAY + 1});
  });
  it('league presets are null without leagues', () => {
    expect(resolvePriceRange('league', [], 9000)).toBeNull();
    expect(resolvePriceRange('prevLeague', [], 9000)).toBeNull();
  });
});

describe('availablePresets', () => {
  it('hides league presets without leagues', () => {
    expect(availablePresets([], 9000)).toEqual(['all', '7d', '1d']);
    expect(defaultPreset([], 9000)).toBe('all');
  });
  it('offers both league presets when a previous league exists', () => {
    expect(availablePresets(ranges, 9000)).toEqual(['league', 'prevLeague', 'all', '7d', '1d']);
    expect(defaultPreset(ranges, 9000)).toBe('league');
  });
  it('omits prevLeague in the first league', () => {
    expect(availablePresets(ranges, 2000)).toEqual(['league', 'all', '7d', '1d']);
  });
});
