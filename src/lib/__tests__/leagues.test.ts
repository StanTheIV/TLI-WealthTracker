import {describe, expect, it} from 'vitest';
import bundled from '../../../resources/leagues.json';
import {
  currentLeague,
  fromLocalInputValue,
  isStalePrice,
  leagueAt,
  leagueRanges,
  mergeLeagues,
  parseLeaguesJson,
  toLocalInputValue,
  type League,
} from '../leagues';

const DAY = 24 * 3_600_000;
const L = (id: string, startsAt: number, source: League['source'] = 'bundled', name = id): League => ({
  id,
  name,
  startsAt,
  source,
});

describe('leagueRanges / leagueAt / currentLeague', () => {
  const ranges = leagueRanges([L('B', 2000), L('A', 1000), L('C', 3000)]);

  it('sorts by start and chains to/from', () => {
    expect(ranges.map(r => [r.id, r.from, r.to])).toEqual([
      ['A', 1000, 2000],
      ['B', 2000, 3000],
      ['C', 3000, null],
    ]);
  });

  it('is half-open at boundaries', () => {
    expect(leagueAt(ranges, 1000)?.id).toBe('A');
    expect(leagueAt(ranges, 1999)?.id).toBe('A');
    expect(leagueAt(ranges, 2000)?.id).toBe('B');
    expect(leagueAt(ranges, 3000)?.id).toBe('C');
    expect(leagueAt(ranges, 9e12)?.id).toBe('C');
  });

  it('returns undefined before the first league', () => {
    expect(leagueAt(ranges, 999)).toBeUndefined();
    expect(leagueAt([], 5)).toBeUndefined();
  });

  it('currentLeague picks the league at now', () => {
    expect(currentLeague(ranges, 2500)?.id).toBe('B');
  });
});

describe('mergeLeagues', () => {
  it('inserts missing official rows and is a no-op when nothing changed', () => {
    const official = [L('SS1', 1000), L('SS2', 100 * DAY)];
    const first = mergeLeagues([], official);
    expect(first.upserts).toEqual(official);
    expect(first.deletes).toEqual([]);
    const second = mergeLeagues(official, official);
    expect(second).toEqual({upserts: [], deletes: []});
  });

  it('updates a changed bundled row', () => {
    const r = mergeLeagues([L('SS1', 1000)], [L('SS1', 2000)]);
    expect(r.upserts).toEqual([L('SS1', 2000)]);
  });

  it('remote overrides bundled but bundled never downgrades remote', () => {
    const up = mergeLeagues([L('SS1', 1000, 'bundled')], [L('SS1', 5000, 'remote')]);
    expect(up.upserts).toEqual([L('SS1', 5000, 'remote')]);
    const down = mergeLeagues([L('SS1', 5000, 'remote')], [L('SS1', 1000, 'bundled')]);
    expect(down.upserts).toEqual([]);
  });

  it('prefers remote over bundled when both are supplied for the same id', () => {
    const r = mergeLeagues([], [L('SS1', 5000, 'remote'), L('SS1', 1000, 'bundled')]);
    expect(r.upserts).toEqual([L('SS1', 5000, 'remote')]);
  });

  it('deletes user rows within +-7 days of an official start, keeps others', () => {
    const t = 100 * DAY;
    const stored = [
      L('SS1', t, 'bundled'),
      L('user-1', t + 7 * DAY, 'user'),
      L('user-2', t - 7 * DAY, 'user'),
      L('user-3', t + 7 * DAY + 1, 'user'),
      L('user-4', t - 30 * DAY, 'user'),
    ];
    const r = mergeLeagues(stored, [L('SS1', t, 'bundled')]);
    expect(r.upserts).toEqual([]);
    expect(r.deletes.sort()).toEqual(['user-1', 'user-2']);
  });

  it('uses the new official date when matching user rows', () => {
    const r = mergeLeagues([L('user-1', 50 * DAY, 'user')], [L('SS9', 52 * DAY, 'remote')]);
    expect(r.upserts).toHaveLength(1);
    expect(r.deletes).toEqual(['user-1']);
  });
});

describe('parseLeaguesJson', () => {
  it('parses valid entries to ms with the given source', () => {
    const r = parseLeaguesJson(
      {version: 1, leagues: [{id: 'X', name: 'Xx', startsAt: '2026-10-16T02:00:00Z'}]},
      'remote',
    );
    expect(r).toEqual([{id: 'X', name: 'Xx', startsAt: Date.UTC(2026, 9, 16, 2), source: 'remote'}]);
  });

  it('returns [] for non-object / missing list input', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, {leagues: 'nope'}]) {
      expect(parseLeaguesJson(bad, 'remote')).toEqual([]);
    }
  });

  it('skips invalid and duplicate entries', () => {
    const r = parseLeaguesJson(
      {
        leagues: [
          null,
          'str',
          {id: 1, name: 'n', startsAt: '2026-01-01T00:00:00Z'},
          {id: 'a', name: '', startsAt: '2026-01-01T00:00:00Z'},
          {id: 'b', name: 'n', startsAt: 'not a date'},
          {id: 'c', name: 'n', startsAt: 12345},
          {id: 'ok', name: 'Fine', startsAt: '2026-01-01T00:00:00Z'},
          {id: 'ok', name: 'Dup', startsAt: '2026-02-01T00:00:00Z'},
        ],
      },
      'bundled',
    );
    expect(r.map(l => l.id)).toEqual(['ok']);
    expect(r[0].name).toBe('Fine');
  });
});

describe('resources/leagues.json', () => {
  it('parses to the 4 known leagues in order', () => {
    const r = parseLeaguesJson(bundled, 'bundled');
    expect(r.map(l => l.id)).toEqual(['SS11', 'SS12', 'SS13', 'SS14']);
    expect(r[3].startsAt).toBe(Date.UTC(2026, 9, 16, 2));
  });
});

describe('isStalePrice', () => {
  const cur = {id: 'SS14', name: 'SS14', source: 'bundled' as const, from: 1000, to: null};
  it('flags priced items observed before the current league', () => {
    expect(isStalePrice({price: 1, priceDate: 999}, cur)).toBe(true);
    expect(isStalePrice({price: 1, priceDate: 1000}, cur)).toBe(false);
  });
  it('ignores unpriced, undated items and a missing league', () => {
    expect(isStalePrice({price: 0, priceDate: 5}, cur)).toBe(false);
    expect(isStalePrice({price: 1, priceDate: 0}, cur)).toBe(false);
    expect(isStalePrice({price: 1, priceDate: 5}, undefined)).toBe(false);
  });
});

describe('datetime-local conversion', () => {
  it('round-trips at minute precision', () => {
    const ts = new Date(2026, 9, 16, 4, 0).getTime();
    expect(toLocalInputValue(ts)).toBe('2026-10-16T04:00');
    expect(fromLocalInputValue('2026-10-16T04:00')).toBe(ts);
  });
  it('rejects invalid input', () => {
    expect(fromLocalInputValue('')).toBeNull();
    expect(fromLocalInputValue('nope')).toBeNull();
  });
});
