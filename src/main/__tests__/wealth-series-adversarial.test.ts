/**
 * 4.5 adversarial: WealthSeries on a real migrated DB. The cache must be
 * invisible: whatever sequence of inserts, deletes, clears, filter / tax /
 * type changes and reads happens, a warm service answers exactly what a cold
 * one (empty cache) answers.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {
  initDb, wealthInsert, wealthGetRange, wealthGetRangeHeads, wealthGetLatest, wealthDelete, wealthClear,
  itemsImportBatch, itemsGetAll, itemsSetType, settingsGetAll, settingsSet,
  filtersGetAll, filtersInsert, filtersUpdate, filtersSetEnabled,
} from '@/main/db';
import {WealthSeries, type WealthSeriesDeps} from '@/main/wealth-series';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import {int, pick, rng} from '@/test/prng';
import type {DbItem, StoredWealthDatapoint} from '@/shared/contracts/db';
import type {FilterRule} from '@/shared/item-filter';

const ITEMS: DbItem[] = [
  {id: '100', name: 'Ember',   type: 'Remembrance Material', price: 10,  priceDate: 1},
  {id: '200', name: 'Fuel',    type: 'Corrosion Material',   price: 1,   priceDate: 1},
  {id: '300', name: 'Compass', type: 'Compass',              price: 100, priceDate: 1},
  {id: '400', name: 'Cube',    type: 'Cube Material',        price: 5,   priceDate: 1},
];
const RAW = ['Remembrance Material', 'Corrosion Material', 'Compass', 'Cube Material', 'Equipment', ''];

type Entry = {qty: number; price: number};
const breakdownOf = (e: Record<string, Entry>) =>
  JSON.stringify(Object.fromEntries(Object.entries(e).map(([id, x]) => [id, {...x, total: x.qty * x.price}])));
const grossOf = (e: Record<string, Entry>) => Object.values(e).reduce((s, x) => s + x.qty * x.price, 0);

function insert(ts: number, e: Record<string, Entry>): StoredWealthDatapoint {
  const value = grossOf(e);
  const breakdown = breakdownOf(e);
  return {id: wealthInsert({timestamp: ts, value, breakdown}), timestamp: ts, value, breakdown};
}

const noLog = {warn: vi.fn()};
const realDeps = (over: Partial<WealthSeriesDeps['points']> = {}): WealthSeriesDeps => ({
  points:   {heads: wealthGetRangeHeads, range: wealthGetRange, latest: wealthGetLatest, ...over},
  items:    {getAll: itemsGetAll},
  filters:  {getAll: filtersGetAll},
  settings: {getAll: settingsGetAll},
  log:      noLog,
});
const build = (over: Partial<WealthSeriesDeps['points']> = {}) => new WealthSeries(realDeps(over));

const hideType = (t: string): FilterRule => ({id: `h-${t}`, action: 'hide', scopes: ['wealth'], kind: {type: 'by-type', itemType: t as never}});
const hideItem = (id: string): FilterRule => ({id: `i-${id}`, action: 'hide', scopes: ['wealth'], kind: {type: 'by-item', itemId: id}});

const P = (a: number, b = 0, c = 0): Record<string, Entry> => ({
  '100': {qty: a, price: 10}, '200': {qty: b || 3, price: 1}, '300': {qty: c || 1, price: 100},
});

beforeEach(() => {
  initDb(openNodeSqlite(), {backup: () => { throw new Error('fresh DB must not back up'); }});
  itemsImportBatch(ITEMS);
  settingsSet('auctionTaxEnabled', 'false');
});

describe('boundary timestamps and run-fill', () => {
  it('several rows sharing the boundary ts of a cached neighbour: none missed, none double-cached', () => {
    // ts 1000 x3, 2000 x3, 3000 x3
    const rows = [1000, 2000, 3000].flatMap(ts => [insert(ts, P(1)), insert(ts, P(2)), insert(ts, P(3))]);
    const ws = build();
    // cache only the middle row of the middle ts (via pointOf), then read everything
    ws.pointOf(rows[4]);
    expect(ws.cachedCount).toBe(1);
    const got = ws.series(0, 5000);
    expect(got.map(p => p.id).sort((a, b) => a - b)).toEqual(rows.map(r => r.id));
    expect(ws.cachedCount).toBe(9);
    expect(got).toEqual(build().series(0, 5000));
  });

  it('alternating cached / uncached rows read as separate runs and every row still appears once', () => {
    const rows = Array.from({length: 12}, (_, i) => insert(1000 + Math.floor(i / 2) * 10, P(i + 1)));
    const ws = build();
    for (let i = 0; i < rows.length; i += 2) ws.pointOf(rows[i]);
    const got = ws.series(0, 1e9);
    expect(got.map(p => p.id)).toEqual(build().series(0, 1e9).map(p => p.id));
    expect(new Set(got.map(p => p.id)).size).toBe(12);
    expect(ws.cachedCount).toBe(12);
  });

  it('inclusive bounds: a row exactly at from or to is in; one just outside is out', () => {
    const a = insert(1000, P(1)); insert(999, P(2)); insert(2001, P(3)); const b = insert(2000, P(4));
    const ws = build();
    expect(ws.series(1000, 2000).map(p => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(ws.series(1000, 1000).map(p => p.id)).toEqual([a.id]);
    expect(ws.series(2000, 1000)).toEqual([]);
    expect(ws.series(1500, 1500)).toEqual([]);
  });

  it('a row inserted between the heads read and the range read is cached but never shown', () => {
    const a = insert(1000, P(1)); const c = insert(3000, P(3));
    let injected: StoredWealthDatapoint | null = null;
    const ws = build({
      range: (from, to) => {
        // lands between the two reads, inside the bounds
        injected ??= insert(2000, P(2));
        return wealthGetRange(from, to);
      },
    });
    const got = ws.series(0, 5000);
    expect(got.map(p => p.id)).toEqual([a.id, c.id]);
    // the next call sees it (it is cached already, and read as a head now)
    expect(ws.series(0, 5000).map(p => p.id)).toEqual([a.id, injected!.id, c.id]);
  });

  it('overlapping ranges served warm equal cold, and the cache holds each row once', () => {
    const rows = Array.from({length: 30}, (_, i) => insert(1000 + i * 100, P(i + 1)));
    const ws = build();
    const ranges: [number, number][] = [[1000, 2000], [1500, 2500], [0, 1e9], [2000, 2000], [1900, 3900], [0, 1e9]];
    for (const [f, t] of ranges) expect(ws.series(f, t)).toEqual(build().series(f, t));
    expect(ws.cachedCount).toBe(rows.length);
  });
});

describe('cache coherence under interleaving (property)', () => {
  it('a warm service always equals a cold one across random insert / delete / clear / filter / tax / type ops', () => {
    const r = rng(4501);
    const ws = build();
    const live: StoredWealthDatapoint[] = [];
    const seenIds = new Set<number>();
    let filterId = 0;

    for (let step = 0; step < 400; step++) {
      const op = r();
      if (op < 0.25) {
        // few distinct timestamps -> many rows share one
        const row = insert(1000 + int(r, 0, 12) * 100, P(int(r, 0, 50), int(r, 0, 9), int(r, 0, 3)));
        expect(seenIds.has(row.id)).toBe(false);
        seenIds.add(row.id);
        live.push(row);
        if (r() < 0.5) ws.pointOf(row);
      } else if (op < 0.33 && live.length > 0) {
        const [gone] = live.splice(int(r, 0, live.length - 1), 1);
        wealthDelete(gone.id); ws.forget(gone.id);
      } else if (op < 0.36) {
        wealthClear(); ws.invalidate(); live.length = 0;
        expect(ws.cachedCount).toBe(0);
      } else if (op < 0.46) {
        const rules = Array.from({length: int(r, 0, 3)}, () =>
          r() < 0.5 ? hideType(pick(r, ['ember', 'fuel', 'compass', 'cube', 'other'])) : hideItem(pick(r, ['100', '200', '300'])));
        if (filterId === 0) { filterId = 1; filtersInsert({id: 'f', name: 'f', enabled: true, rules: JSON.stringify(rules)}); }
        else filtersUpdate({id: 'f', name: 'f', enabled: r() < 0.7, rules: JSON.stringify(rules)});
      } else if (op < 0.50 && filterId) {
        filtersSetEnabled('f', r() < 0.5);
      } else if (op < 0.56) {
        settingsSet('auctionTaxEnabled', r() < 0.5 ? 'true' : 'false');
      } else if (op < 0.62) {
        itemsSetType(pick(r, ['100', '200', '300', '400']), pick(r, RAW));
      } else {
        const from = 1000 + int(r, -2, 12) * 100;
        const to   = from + int(r, 0, 1300);
        const cold = build();
        expect(ws.series(from, to)).toEqual(cold.series(from, to));
        expect(ws.latestBreakdown()).toEqual(cold.latestBreakdown());
        if (live.length > 0) {
          const row = pick(r, live);
          expect(ws.pointOf(row)).toEqual(cold.pointOf(row));
        }
      }
      expect(ws.cachedCount).toBeLessThanOrEqual(live.length);
    }
    // wrap up: whole table, warm vs cold
    expect(ws.series(0, 1e9)).toEqual(build().series(0, 1e9));
    expect(ws.series(0, 1e9).length).toBe(live.length);
  });

  it('ids after clear are fresh: never equal to a cached or earlier id (AUTOINCREMENT)', () => {
    const ws = build();
    const before = [insert(1000, P(1)), insert(2000, P(2))];
    ws.series(0, 1e9);
    wealthClear(); ws.invalidate();
    const after = insert(1000, P(9));
    expect(before.map(b => b.id)).not.toContain(after.id);
    expect(ws.series(0, 1e9)).toEqual([{id: after.id, ts: 1000, value: grossOf(P(9))}]);
  });

  it('forgetting the id of a non-deleted row only costs a re-read, never a wrong value', () => {
    const a = insert(1000, P(1));
    const ws = build();
    const v = ws.series(0, 1e9);
    ws.forget(a.id);
    expect(ws.series(0, 1e9)).toEqual(v);
    ws.forget(99999);
    expect(ws.cachedCount).toBe(1);
  });

  it('a stale (un-forgotten) cache entry for a deleted row does not leak into other ranges', () => {
    const a = insert(1000, P(1)); const b = insert(2000, P(2));
    const ws = build();
    ws.series(0, 1e9);
    wealthDelete(a.id); // forget forgotten on purpose: heads drive output, so it can't resurface
    expect(ws.series(0, 1e9).map(p => p.id)).toEqual([b.id]);
  });
});

describe('policy is read per request', () => {
  it('toggling the filter between two series calls changes values without invalidate', () => {
    insert(1000, P(2)); insert(2000, P(4));
    const ws = build();
    const gross = ws.series(0, 1e9).map(p => p.value);
    filtersInsert({id: 'f', name: 'f', enabled: true, rules: JSON.stringify([hideType('compass')])});
    const hidden = ws.series(0, 1e9).map(p => p.value);
    expect(hidden).toEqual(gross.map(g => g - 100));
    filtersSetEnabled('f', false);
    expect(ws.series(0, 1e9).map(p => p.value)).toEqual(gross);
    filtersSetEnabled('f', true);
    expect(ws.series(0, 1e9).map(p => p.value)).toEqual(hidden);
  });

  it('an item type change mid-way flips by-type inclusion and fuel tax-exemption', () => {
    insert(1000, {'200': {qty: 100, price: 1}});
    const ws = build();
    settingsSet('auctionTaxEnabled', 'true');
    expect(ws.series(0, 1e9)[0].value).toBe(100);           // fuel: exempt
    itemsSetType('200', 'Compass');
    expect(ws.series(0, 1e9)[0].value).toBeCloseTo(85, 9);  // taxable now
    filtersInsert({id: 'f', name: 'f', enabled: true, rules: JSON.stringify([hideType('compass')])});
    expect(ws.series(0, 1e9)[0].value).toBe(0);
    itemsSetType('200', 'Corrosion Material');
    expect(ws.series(0, 1e9)[0].value).toBe(100);
  });

  it('latestBreakdown follows the same live policy and its rows sum to its value', () => {
    insert(1000, P(2)); insert(2000, P(4, 7, 2));
    const ws = build();
    for (const tax of ['false', 'true']) for (const rules of [[], [hideType('ember')], [hideItem('300'), hideType('fuel')]]) {
      settingsSet('auctionTaxEnabled', tax);
      filtersGetAll().forEach(f => filtersSetEnabled(f.id, false));
      if (rules.length) { filtersInsert({id: `f${Math.random()}`, name: 'x', enabled: true, rules: JSON.stringify(rules)}); }
      const lb = ws.latestBreakdown()!;
      expect(lb.rows.reduce((s, x) => s + x.total, 0)).toBeCloseTo(lb.value, 9);
      expect(lb.value).toBeCloseTo(ws.series(0, 1e9).at(-1)!.value, 9);
    }
  });

  it('latestBreakdown on equal timestamps agrees with itself across calls and the series tail', () => {
    insert(5000, P(1)); insert(5000, P(2)); insert(5000, P(3));
    const ws = build();
    const lb = ws.latestBreakdown()!;
    expect(ws.latestBreakdown()).toEqual(lb);
    expect(ws.series(0, 1e9).map(p => p.id)).toContain(lb.id);
  });
});

describe('stored value fidelity', () => {
  it('filter off + tax off: every series value is the stored value (breakdown sums within rounding)', () => {
    const r = rng(77);
    const rows = Array.from({length: 60}, (_, i) => insert(1000 + i, P(int(r, 0, 400), int(r, 1, 50), int(r, 1, 9))));
    const got = build().series(0, 1e9);
    rows.forEach((row, i) => expect(got[i].value).toBeCloseTo(row.value, 6));
  });

  it('pre-breakdown rows ({} / garbage) keep their stored value under any filter and tax', () => {
    const empty = wealthInsert({timestamp: 1000, value: 321, breakdown: '{}'});
    const junk  = wealthInsert({timestamp: 2000, value: 654, breakdown: 'not json'});
    const arr   = wealthInsert({timestamp: 3000, value: 987, breakdown: '[]'});
    filtersInsert({id: 'f', name: 'f', enabled: true, rules: JSON.stringify([hideType('compass'), hideType('other')])});
    settingsSet('auctionTaxEnabled', 'true');
    const got = build().series(0, 1e9);
    expect(got).toEqual([{id: empty, ts: 1000, value: 321}, {id: junk, ts: 2000, value: 654}, {id: arr, ts: 3000, value: 987}]);
  });

  it('a latestBreakdown on an empty table is null; series is []', () => {
    const ws = build();
    expect(ws.latestBreakdown()).toBeNull();
    expect(ws.series(0, 1e9)).toEqual([]);
  });
});
