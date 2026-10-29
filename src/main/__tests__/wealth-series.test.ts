/**
 * WealthSeries (step 4.5b): the displayed wealth figures, valued in main from
 * stored gross points with the CURRENT active filter ('wealth' scope), today's
 * item types and the auction-tax setting. Real migrated node:sqlite DB via
 * db.ts (initDb), real wealth / items / filters / settings rows.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {
  initDb, getDb, wealthInsert, wealthGetRange, wealthGetRangeHeads, wealthGetLatest, wealthDelete, wealthClear,
  itemsImportBatch, itemsGetAll, itemsSetType, settingsGetAll, settingsSet,
  filtersGetAll, filtersInsert, filtersUpdate, filtersSetEnabled,
} from '@/main/db';
import {WealthSeries} from '@/main/wealth-series';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import type {DbItem, StoredWealthDatapoint} from '@/shared/contracts/db';
import type {WealthBreakdownRow} from '@/shared/contracts/wealth';
import type {FilterRule} from '@/shared/item-filter';

// -- fixture -----------------------------------------------------------------

const EMBER   = '100'; // 'Remembrance Material' -> ember (taxable)
const FUEL    = '200'; // 'Corrosion Material'   -> fuel (tax exempt)
const COMPASS = '300'; // 'Compass'              -> compass (taxable)

const ITEMS: DbItem[] = [
  {id: EMBER,   name: 'Ember',   type: 'Remembrance Material', price: 10,  priceDate: 1},
  {id: FUEL,    name: 'Fuel',    type: 'Corrosion Material',   price: 1,   priceDate: 1},
  {id: COMPASS, name: 'Compass', type: 'Compass',              price: 100, priceDate: 1},
];

type Entry = {qty: number; price: number};
function breakdownOf(entries: Record<string, Entry>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(entries).map(([id, e]) => [id, {...e, total: e.qty * e.price}]),
  ));
}
const grossOf = (entries: Record<string, Entry>) =>
  Object.values(entries).reduce((s, e) => s + e.qty * e.price, 0);

/** Inserts a gross point and returns its row (with id). */
function addPoint(timestamp: number, entries: Record<string, Entry>): StoredWealthDatapoint {
  return addRaw(timestamp, grossOf(entries), breakdownOf(entries));
}
function addRaw(timestamp: number, value: number, breakdown: string): StoredWealthDatapoint {
  const id = wealthInsert({timestamp, value, breakdown});
  return {id, timestamp, value, breakdown};
}

const P1: Record<string, Entry> = {[EMBER]: {qty: 2, price: 10}, [FUEL]: {qty: 10, price: 1}, [COMPASS]: {qty: 1, price: 100}}; // gross 130
const P2: Record<string, Entry> = {[EMBER]: {qty: 5, price: 10}, [FUEL]: {qty: 20, price: 1}};                                   // gross 70

const hideType = (itemType: string, scopes: string[] = ['wealth']): FilterRule =>
  ({id: `r-${itemType}`, action: 'hide', scopes: scopes as FilterRule['scopes'], kind: {type: 'by-type', itemType: itemType as never}});
const hideItem = (itemId: string): FilterRule =>
  ({id: `ri-${itemId}`, action: 'hide', scopes: ['wealth'], kind: {type: 'by-item', itemId}});

function addFilter(rules: FilterRule[], enabled = true, id = 'f1'): void {
  filtersInsert({id, name: id, enabled, rules});
}
/** An enabled filter row whose stored rules JSON is `json`, bypassing db.ts's validation. */
function addRawFilter(json: string, id = 'f1'): void {
  getDb().prepare('INSERT INTO item_filters (id, name, enabled, rules) VALUES (?, ?, 1, ?)').run(id, id, json);
}
const taxOn  = () => settingsSet('auctionTaxEnabled', 'true');
const taxOff = () => settingsSet('auctionTaxEnabled', 'false');

let ws: WealthSeries;

function build(): WealthSeries {
  return new WealthSeries({
    points:   {heads: wealthGetRangeHeads, range: wealthGetRange, latest: wealthGetLatest},
    items:    {getAll: itemsGetAll},
    filters:  {getAll: filtersGetAll},
    settings: {getAll: settingsGetAll},
  });
}

const sum = (rows: WealthBreakdownRow[]) => rows.reduce((s, r) => s + r.total, 0);

beforeEach(() => {
  initDb(openNodeSqlite(), {backup: () => { throw new Error('fresh DB must not back up'); }});
  itemsImportBatch(ITEMS);
  taxOff();
  ws = build();
});

describe('WealthSeries.series', () => {
  it('returns {id, ts, value} points in ts order, range inclusive, regardless of insert order', () => {
    const b = addPoint(3000, P2);
    const a = addPoint(1000, P1);
    const c = addPoint(2000, P1);
    addPoint(9000, P2); // outside
    const out = ws.series(1000, 3000);
    expect(out).toEqual([
      {id: a.id, ts: 1000, value: 130},
      {id: c.id, ts: 2000, value: 130},
      {id: b.id, ts: 3000, value: 70},
    ]);
    expect(Object.keys(out[0]).sort()).toEqual(['id', 'ts', 'value']);
  });

  it('is empty for an empty range', () => {
    addPoint(1000, P1);
    expect(ws.series(5000, 6000)).toEqual([]);
  });

  it('no filter + tax off equals the stored values', () => {
    addPoint(1000, P1);
    addPoint(2000, P2);
    expect(ws.series(0, 9999).map(p => p.value)).toEqual([130, 70]);
  });

  it('tax on discounts taxable items only (fuel exempt); flipping the setting needs no invalidate', () => {
    addPoint(1000, P1);
    taxOn();
    // ember 20 * .85 + fuel 10 + compass 100 * .85
    expect(ws.series(0, 9999)[0].value).toBeCloseTo(17 + 10 + 85, 9);
    taxOff();
    expect(ws.series(0, 9999)[0].value).toBe(130);
  });

  it('the active filter\'s wealth-scoped rules hide items', () => {
    addPoint(1000, P1);
    addFilter([hideType('fuel')]);
    expect(ws.series(0, 9999)[0].value).toBe(120);
  });

  it('a by-item rule hides that item', () => {
    addPoint(1000, P1);
    addFilter([hideItem(COMPASS)]);
    expect(ws.series(0, 9999)[0].value).toBe(30);
  });

  it('a rule not scoped to wealth does not affect wealth', () => {
    addPoint(1000, P1);
    addFilter([hideType('fuel', ['session', 'map'])]);
    expect(ws.series(0, 9999)[0].value).toBe(130);
  });

  it('filter + tax compose', () => {
    addPoint(1000, P1);
    addFilter([hideType('compass')]);
    taxOn();
    expect(ws.series(0, 9999)[0].value).toBeCloseTo(17 + 10, 9);
  });

  it('a disabled filter is ignored; enabling it applies without invalidate', () => {
    addPoint(1000, P1);
    addFilter([hideType('fuel')], false);
    expect(ws.series(0, 9999)[0].value).toBe(130);
    filtersSetEnabled('f1', true);
    expect(ws.series(0, 9999)[0].value).toBe(120);
  });

  it('only the ENABLED filter applies when several exist', () => {
    addPoint(1000, P1);
    addFilter([hideType('fuel')], false, 'off');
    addFilter([hideType('compass')], true, 'on');
    expect(ws.series(0, 9999)[0].value).toBe(30);
  });

  it('unreadable stored filter JSON fails the request, naming the filter (never shown unfiltered)', () => {
    addPoint(1000, P1);
    addRawFilter('{not json');
    expect(() => ws.series(0, 9999)).toThrow(/f1/);
    expect(() => ws.latestBreakdown()).toThrow(/f1/);
  });

  it('an item type change flips inclusion (types are read per request)', () => {
    addPoint(1000, P1);
    addFilter([hideType('fuel')]);
    expect(ws.series(0, 9999)[0].value).toBe(120);
    itemsSetType(FUEL, 'Dream Material'); // no longer fuel
    expect(ws.series(0, 9999)[0].value).toBe(130);
    itemsSetType(COMPASS, 'Corrosion Material'); // compass becomes fuel, so the hide rule now catches it
    expect(ws.series(0, 9999)[0].value).toBe(30);
  });

  it('a type change also flips tax exemption', () => {
    addPoint(1000, {[FUEL]: {qty: 10, price: 1}});
    taxOn();
    expect(ws.series(0, 9999)[0].value).toBe(10);
    itemsSetType(FUEL, 'Dream Material');
    expect(ws.series(0, 9999)[0].value).toBeCloseTo(8.5, 9);
  });

  it('an item missing from the items table counts as other (included, taxed)', () => {
    addPoint(1000, {'999': {qty: 2, price: 50}});
    taxOn();
    expect(ws.series(0, 9999)[0].value).toBeCloseTo(85, 9);
    addFilter([hideType('other')]);
    expect(ws.series(0, 9999)[0].value).toBe(0);
  });

  it('a point whose items are all hidden is worth 0, not its stored value', () => {
    addPoint(1000, P1);
    addFilter([hideType('ember'), hideType('fuel'), hideType('compass')]);
    expect(ws.series(0, 9999)[0].value).toBe(0);
  });

  it('empty and unparseable breakdowns keep their stored value, whatever the filter and tax', () => {
    const empty = addRaw(1000, 55, '{}');
    const junk  = addRaw(2000, 66, 'not json');
    const arr   = addRaw(3000, 77, '[1,2]');
    addFilter([hideType('ember'), hideType('fuel'), hideType('compass'), hideType('other')]);
    taxOn();
    expect(ws.series(0, 9999)).toEqual([
      {id: empty.id, ts: 1000, value: 55},
      {id: junk.id,  ts: 2000, value: 66},
      {id: arr.id,   ts: 3000, value: 77},
    ]);
  });

  it('a breakdown with a malformed entry shows its stored value and does not break the other points', () => {
    addPoint(1000, P1);
    const nul = addRaw(2000, 66, '{"1":null}');
    const str = addRaw(3000, 77, `{"${EMBER}":{"qty":"2","price":10,"total":20}}`);
    addPoint(4000, P2);
    taxOn();
    expect(ws.series(0, 9999).map(p => p.value)).toEqual([
      130 - 0.15 * (20 + 100), 66, 77, 70 - 0.15 * 50,
    ].map(x => expect.closeTo(x, 9)));
    expect(ws.series(0, 9999).map(p => p.id).slice(1, 3)).toEqual([nul.id, str.id]);
  });

  it('a malformed latest point has no rows and shows its stored value', () => {
    addPoint(1000, P1);
    const row = addRaw(2000, 66, `{"${EMBER}":{"qty":1,"price":1,"total":1},"x":[1]}`);
    expect(ws.latestBreakdown()).toEqual({id: row.id, ts: 2000, value: 66, rows: []});
    expect(ws.pointOf(row)).toEqual({id: row.id, ts: 2000, value: 66});
  });

  it('a point with qty <= 0 items: value equals the sum of its rows (compact form drops them like rows do)', () => {
    const entries = {
      [EMBER]:   {qty: 3,  price: 10},
      [FUEL]:    {qty: 0,  price: 1},
      [COMPASS]: {qty: -2, price: 100},
    };
    // stored value deliberately includes the -200; display must not
    const row = addRaw(1000, grossOf(entries), breakdownOf(entries));
    const value = ws.series(0, 9999)[0].value;
    const latest = ws.latestBreakdown()!;
    expect(latest.id).toBe(row.id);
    expect(latest.rows.map(r => r.id)).toEqual([EMBER]);
    expect(value).toBe(sum(latest.rows));
    expect(value).toBe(30);
    taxOn();
    expect(ws.series(0, 9999)[0].value).toBeCloseTo(sum(ws.latestBreakdown()!.rows), 9);
    expect(ws.series(0, 9999)[0].value).toBeCloseTo(25.5, 9);
  });

  it('ids like "constructor" / "__proto__" do not hit the prototype', () => {
    addPoint(1000, {constructor: {qty: 2, price: 5}, toString: {qty: 1, price: 1}});
    expect(ws.series(0, 9999)[0].value).toBe(11);
  });

  it('cache hit returns identical values, also after unrelated writes', () => {
    addPoint(1000, P1);
    addPoint(2000, P2);
    const first = ws.series(0, 9999);
    expect(ws.series(0, 9999)).toEqual(first);
    addPoint(3000, P1); // a new point does not disturb cached ones
    expect(ws.series(0, 9999).slice(0, 2)).toEqual(first);
    expect(ws.series(1500, 2500)).toEqual([first[1]]);
  });
});

describe('WealthSeries.forget / invalidate', () => {
  it('a deleted point is gone from the series; the others keep their values', () => {
    const a = addPoint(1000, P1);
    const b = addPoint(2000, P2);
    ws.series(0, 9999); // warm
    wealthDelete(a.id!);
    ws.forget(a.id!);
    expect(ws.series(0, 9999)).toEqual([{id: b.id, ts: 2000, value: 70}]);
  });

  it('after a clear + invalidate, new points (new ids) are valued fresh, never from a dropped one', () => {
    const a = addPoint(1000, P1);
    ws.series(0, 9999); // warm
    wealthClear();
    ws.invalidate();
    expect(ws.series(0, 9999)).toEqual([]);
    expect(ws.latestBreakdown()).toBeNull();
    const n = addPoint(1000, P2);
    expect(n.id).not.toBe(a.id); // AUTOINCREMENT: ids are never reused
    expect(ws.series(0, 9999)).toEqual([{id: n.id, ts: 1000, value: 70}]);
  });

  it('invalidate then series still values correctly (cache is only an optimisation)', () => {
    addPoint(1000, P1);
    const before = ws.series(0, 9999);
    ws.invalidate();
    expect(ws.series(0, 9999)).toEqual(before);
  });
});

describe('WealthSeries.pointOf', () => {
  it('equals the series\' value for the same row (no filter, filter, tax)', () => {
    const rows = [addPoint(1000, P1), addPoint(2000, P2), addRaw(3000, 55, '{}')];
    for (const setup of [() => {}, () => addFilter([hideType('fuel')]), taxOn]) {
      setup();
      const series = ws.series(0, 9999);
      rows.forEach((row, i) => {
        expect(ws.pointOf(row)).toEqual(series[i]);
      });
    }
  });

  it('values a row that is not yet cached (a fresh live insert) and returns {id, ts, value}', () => {
    const row = addPoint(1000, P1);
    expect(ws.pointOf(row)).toEqual({id: row.id, ts: 1000, value: 130});
    addFilter([hideType('compass')]);
    expect(ws.pointOf(row)).toEqual({id: row.id, ts: 1000, value: 30});
  });

  it('the live point equals the next series() last point', () => {
    addPoint(1000, P2);
    const live = addPoint(2000, P1);
    taxOn();
    addFilter([hideType('fuel')]);
    const p = ws.pointOf(live);
    expect(ws.series(0, 9999).at(-1)).toEqual(p);
  });
});

describe('WealthSeries.latestBreakdown', () => {
  it('is null with no points', () => {
    expect(ws.latestBreakdown()).toBeNull();
  });

  it('is the latest-by-ts point; rows carry qty, unit price, total and sum to its value', () => {
    addPoint(2000, P2);
    const latest = addPoint(5000, P1);
    addPoint(1000, P2);
    const lb = ws.latestBreakdown()!;
    expect(lb.id).toBe(latest.id);
    expect(lb.ts).toBe(5000);
    expect(lb.value).toBe(130);
    expect(lb.rows).toEqual([
      {id: EMBER,   qty: 2,  unitPrice: 10,  total: 20},
      {id: FUEL,    qty: 10, unitPrice: 1,   total: 10},
      {id: COMPASS, qty: 1,  unitPrice: 100, total: 100},
    ]);
    expect(sum(lb.rows)).toBe(lb.value);
  });

  it('hidden items are excluded and the rows still sum to the value (= the series\' last)', () => {
    addPoint(1000, P2);
    addPoint(2000, P1);
    addFilter([hideType('fuel')]);
    const lb = ws.latestBreakdown()!;
    expect(lb.rows.map(r => r.id)).toEqual([EMBER, COMPASS]);
    expect(lb.value).toBe(120);
    expect(sum(lb.rows)).toBe(lb.value);
    expect(lb.value).toBe(ws.series(0, 9999).at(-1)!.value);
  });

  it('tax applies to unit price and total (fuel exempt) and the rows sum to the value', () => {
    addPoint(1000, P1);
    taxOn();
    const lb = ws.latestBreakdown()!;
    const ember = lb.rows.find(r => r.id === EMBER)!;
    const fuel  = lb.rows.find(r => r.id === FUEL)!;
    expect(ember.unitPrice).toBeCloseTo(8.5, 9);
    expect(ember.total).toBeCloseTo(17, 9);
    expect(fuel.unitPrice).toBe(1);
    expect(fuel.total).toBe(10);
    expect(sum(lb.rows)).toBeCloseTo(lb.value, 9);
  });

  it('a latest point without breakdown detail has no rows and shows its stored value', () => {
    const row = addRaw(1000, 55, '{}');
    expect(ws.latestBreakdown()).toEqual({id: row.id, ts: 1000, value: 55, rows: []});
  });
});

describe('WealthSeries cache', () => {
  /** A series whose breakdown reads are recorded as [from, to] ranges. */
  function spied() {
    const reads: Array<[number, number]> = [];
    const series = new WealthSeries({
      points: {
        heads:  wealthGetRangeHeads,
        range:  (from, to) => { reads.push([from, to]); return wealthGetRange(from, to); },
        latest: wealthGetLatest,
      },
      items: {getAll: itemsGetAll}, filters: {getAll: filtersGetAll}, settings: {getAll: settingsGetAll},
    });
    return {series, reads};
  }

  it('caches every point it valued: a repeat, a narrower range or a policy change reads no breakdown', () => {
    for (const t of [1000, 2000, 3000]) addPoint(t, P1);
    const {series, reads} = spied();
    const first = series.series(0, 9999);
    expect(reads).toEqual([[1000, 3000]]);
    expect(series.cachedCount).toBe(3);
    taxOn();
    addFilter([hideType('fuel')]);
    itemsSetType(EMBER, 'Compass');
    expect(series.series(0, 9999).map(p => p.value)).not.toEqual(first.map(p => p.value));
    series.series(1500, 2500);
    expect(reads).toEqual([[1000, 3000]]);
  });

  it('a wider range reads only its uncached runs', () => {
    for (const t of [1000, 2000, 3000, 4000, 5000]) addPoint(t, P2);
    const {series, reads} = spied();
    series.series(2500, 3500);
    expect(reads).toEqual([[3000, 3000]]);
    series.series(0, 9999);
    expect(reads).toEqual([[3000, 3000], [1000, 2000], [4000, 5000]]);
    expect(series.cachedCount).toBe(5);
  });

  it('pointOf and latestBreakdown cache the row: the next series reads nothing for it', () => {
    addPoint(1000, P1);
    const live = addPoint(2000, P2);
    const {series, reads} = spied();
    series.latestBreakdown();
    series.pointOf(live);
    expect(series.cachedCount).toBe(1);
    series.series(0, 9999);
    expect(reads).toEqual([[1000, 1000]]);
  });

  it('forget drops exactly that point; invalidate drops them all', () => {
    const a = addPoint(1000, P1);
    addPoint(2000, P2);
    ws.series(0, 9999);
    expect(ws.cachedCount).toBe(2);
    ws.forget(a.id);
    expect(ws.cachedCount).toBe(1);
    ws.forget(a.id); // idempotent
    expect(ws.cachedCount).toBe(1);
    ws.invalidate();
    expect(ws.cachedCount).toBe(0);
  });

  it('cached points share one interned id per distinct item; invalidate drops the table', () => {
    for (let i = 0; i < 50; i++) addPoint(1000 + i, i % 2 ? P1 : P2);
    addPoint(2000, {'999': {qty: 1, price: 1}});
    const cold = ws.series(0, 9999);
    expect(ws.cachedCount).toBe(51);
    expect(ws.internedIdCount).toBe(4); // EMBER, FUEL, COMPASS, '999'
    ws.latestBreakdown();
    ws.series(0, 9999);
    expect(ws.internedIdCount).toBe(4);
    ws.invalidate();
    expect(ws.internedIdCount).toBe(0);
    expect(ws.series(0, 9999)).toEqual(cold);
    expect(ws.internedIdCount).toBe(4);
  });

  it('valid JSON that is not a rule list fails too; rewriting the filter recovers, uncached', () => {
    addPoint(1000, P1);
    addRawFilter('"a string"', 'f2');
    expect(() => ws.series(0, 9999)).toThrow(/f2/);
    filtersUpdate({id: 'f2', name: 'f2', enabled: true, rules: [hideType('compass')]});
    expect(ws.series(0, 9999)[0].value).toBe(30);
  });
});
