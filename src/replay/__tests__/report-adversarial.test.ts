/**
 * compareRows pairing across the start-time change: sessions saved before it
 * derived `startedAt = finish - elapsed`; replays carry the real start.
 */
import {describe, it, expect} from 'vitest';
import type {DbSessionMap} from '@/shared/contracts/db';
import {compareRows} from '@/replay/report';

const T0 = Date.UTC(2026, 9, 1, 12);
const row = (over: Partial<DbSessionMap>): DbSessionMap => ({
  sessionId: 's', mapIndex: 1, startedAt: T0, endedAt: T0 + 60_000, duration: 60_000, drops: {'100': 1}, spent: {},
  seasonalType: null, parentMapIndex: null, phase: null, ...over,
});

/** The same run as saved by an old build: start = finish - elapsed. */
const asOld = (r: DbSessionMap): DbSessionMap => ({...r, startedAt: r.endedAt - r.duration});

describe('derived-start old rows against real-start replay rows', () => {
  it('a map frozen 10 minutes and its arcana overlap pair one-to-one with their replays', () => {
    const map     = row({startedAt: T0, endedAt: T0 + 700_000, duration: 100_000});
    const overlap = row({startedAt: T0 + 100_000, endedAt: T0 + 650_000, duration: 80_000, seasonalType: 'arcana', parentMapIndex: 1});
    const cmp = compareRows([map, overlap], [asOld(map), asOld(overlap)]);

    expect(cmp.filter(c => c.replay && c.stored)).toHaveLength(2);
    expect(cmp.every(c => c.fields.length === 0 && c.drops.length === 0)).toBe(true);
    expect(cmp.find(c => c.replay === overlap)?.stored).toEqual(asOld(overlap));
  });

  it('two same-type maps with a frozen first one do not cross-pair', () => {
    const a = row({mapIndex: 1, startedAt: T0,           endedAt: T0 + 300_000, duration: 60_000});
    const b = row({mapIndex: 2, startedAt: T0 + 300_000, endedAt: T0 + 360_000, duration: 60_000});
    const cmp = compareRows([a, b], [asOld(a), asOld(b)]);
    expect(cmp.map(c => [c.replay?.mapIndex, c.stored?.mapIndex])).toEqual([[1, 1], [2, 2]]);
  });

  it('pairs at exactly the tolerance and not one ms beyond, on the finish', () => {
    const base = row({});
    const at   = compareRows([base], [row({startedAt: T0 + 59_000, endedAt: T0 + 65_000})]);
    const past = compareRows([base], [row({startedAt: T0 + 59_000, endedAt: T0 + 65_001})]);
    expect(at.map(c => c.stored !== null)).toEqual([true]);
    expect(past.map(c => [c.replay !== null, c.stored !== null])).toEqual([[true, false], [false, true]]);
  });

  it('never pairs rows of different seasonal types, however close', () => {
    const cmp = compareRows([row({seasonalType: 'arcana'})], [row({seasonalType: 'vorex'})]);
    expect(cmp.map(c => [c.replay !== null, c.stored !== null])).toEqual([[true, false], [false, true]]);
  });

  it('with one stored row and two close replays, only one pairs; the other is reported alone', () => {
    const cmp = compareRows([row({}), row({mapIndex: 2})], [row({})]);
    expect(cmp.filter(c => c.stored)).toHaveLength(1);
    expect(cmp.filter(c => !c.stored)).toHaveLength(1);
  });

  it('empty on either side', () => {
    expect(compareRows([], [])).toEqual([]);
    expect(compareRows([row({})], []).map(c => c.stored)).toEqual([null]);
    expect(compareRows([], [row({})]).map(c => c.replay)).toEqual([null]);
  });
});
