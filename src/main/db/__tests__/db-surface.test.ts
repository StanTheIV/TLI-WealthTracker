/**
 * Remaining db.ts exports on the node:sqlite driver (db.test.ts covers the
 * transaction sites). Together the two files exercise every exported function.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {
  initDb, getDb, itemsCount, itemsGetAll, itemsImportBatch, itemsSetName, itemsSetType, itemsSetPrice,
  itemsSetLocked, itemsGetLocked, getLookupCountToday, recordLookup,
  wealthInsert, wealthGetRange, wealthGetRangeHeads, wealthGetLatest, wealthDelete, wealthClear,
  filtersInsert, filtersUpdate, filtersDelete, filtersGetAll,
  priceRecord, pricesHistory, pricesMovers, pricesExport,
  leaguesInsertUser, leaguesGetAll, leaguesSetStart,
} from '@/main/db';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import type {FilterRule} from '@/shared/item-filter';

beforeEach(() => {
  initDb(openNodeSqlite(), {backup: () => {}});
  itemsImportBatch([{id: '100', name: 'Ember', type: 'ember', price: 0, priceDate: 0}]);
});

describe('db.ts surface', () => {
  it('item setters and the locked flag', () => {
    expect(itemsCount()).toBe(1);
    itemsSetName('100', 'Flame Ember');
    itemsSetType('100', 'currency');
    itemsSetPrice('100', 7.5, 1234);
    expect(itemsGetLocked('100')).toBe(false);
    itemsSetLocked('100', true);
    expect(itemsGetLocked('100')).toBe(true);
    expect(itemsGetLocked('missing')).toBe(false);
    expect(itemsGetAll()).toEqual([{id: '100', name: 'Flame Ember', type: 'currency', price: 7.5, priceDate: 1234, locked: true}]);
    itemsSetLocked('100', false);
    expect(itemsGetLocked('100')).toBe(false);
  });

  it('lookup counter counts only today', () => {
    expect(getLookupCountToday()).toBe(0);
    recordLookup('100');
    recordLookup('200');
    getDb().prepare("INSERT INTO api_lookups (date, item_id, timestamp) VALUES ('2000-01-01', '1', 0)").run();
    expect(getLookupCountToday()).toBe(2);
  });

  it('wealth: range is inclusive and ordered, latest is the tail in ascending order, delete removes one', () => {
    for (const t of [30, 10, 20, 40]) wealthInsert({timestamp: t, value: t * 2, breakdown: t === 20 ? '{"100":{}}' : '{}'});
    expect(wealthGetRange(10, 30).map(p => p.timestamp)).toEqual([10, 20, 30]);
    const read = wealthGetRange(10, 30)[1];
    expect(read).toEqual({id: read.id, timestamp: 20, value: 40, breakdown: '{"100":{}}'});
    expect(wealthGetLatest(2).map(p => p.timestamp)).toEqual([30, 40]);
    const id = wealthGetRange(20, 20)[0].id!;
    expect(typeof id).toBe('number');
    wealthDelete(id);
    expect(wealthGetRange(0, 100).map(p => p.timestamp)).toEqual([10, 30, 40]);
  });

  it('wealth: insert returns the new id, never reused after a clear; heads are the range without breakdowns', () => {
    const a = wealthInsert({timestamp: 20, value: 2, breakdown: '{"100":{}}'});
    const b = wealthInsert({timestamp: 10, value: 1, breakdown: '{}'});
    expect(b).toBe(a + 1);
    expect(wealthGetRange(0, 100).map(p => p.id)).toEqual([b, a]);
    expect(wealthGetRangeHeads(0, 100)).toEqual([{id: b, timestamp: 10, value: 1}, {id: a, timestamp: 20, value: 2}]);
    expect(wealthGetRangeHeads(15, 20)).toEqual([{id: a, timestamp: 20, value: 2}]);
    wealthClear();
    expect(wealthInsert({timestamp: 5, value: 0, breakdown: '{}'})).toBe(b + 1);
  });

  it('filters: insert, update, delete', () => {
    const hide: FilterRule = {id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session']};
    const show: FilterRule = {id: 'r2', action: 'show', kind: {type: 'by-item', itemId: '100'}, scopes: ['map']};
    filtersInsert({id: 'f1', name: 'A', enabled: false, rules: []});
    filtersInsert({id: 'f2', name: 'B', enabled: true,  rules: [hide]});
    filtersUpdate({id: 'f1', name: 'A2', enabled: true, rules: [show]});
    expect(filtersGetAll()).toEqual([
      {id: 'f1', name: 'A2', enabled: true, rules: [show]},
      {id: 'f2', name: 'B',  enabled: false, rules: [hide]}, // at most one enabled filter
    ]);
    filtersDelete('f1');
    expect(filtersGetAll().map(f => f.id)).toEqual(['f2']);
  });

  it('price history, movers and export over seeded observations', () => {
    const conn = getDb();
    itemsSetName('100', 'Ember');
    const ins = conn.prepare("INSERT INTO price_observations (item_id, timestamp, source, price) VALUES (?, ?, 'manual', ?)");
    ins.run('100', 1000, 10);
    ins.run('100', 2000, 15);
    ins.run('100', 3000, 12);
    ins.run('999', 2500, 0);   // unknown item, first price 0 -> pctChange null
    ins.run('100', 9000, 99);  // outside the window

    const exported = pricesExport(0, 5000);
    expect(exported.map(r => [r.timestamp, r.itemId, r.name, r.price])).toEqual([
      [1000, '100', 'Ember', 10], [2000, '100', 'Ember', 15], [2500, '999', '', 0], [3000, '100', 'Ember', 12],
    ]);
    expect(exported[0]).toMatchObject({source: 'manual', n: null, p10: null, min: null});

    const movers = pricesMovers(0, 5000).sort((a, b) => a.itemId.localeCompare(b.itemId));
    expect(movers).toHaveLength(2);
    expect(movers[0]).toMatchObject({itemId: '100', name: 'Ember', first: 10, last: 12, min: 10, max: 15, count: 3});
    expect(movers[0].pctChange).toBeCloseTo(0.2);
    expect(movers[1]).toMatchObject({itemId: '999', name: '', type: 'other', pctChange: null});

    const hist = pricesHistory('100', 0, 5000);
    expect(hist.length).toBeGreaterThan(0);
    expect(hist.every(b => typeof b.timestamp === 'number')).toBe(true);
    expect(pricesHistory('nope', 0, 5000)).toEqual([]);
  });

  it('priceRecord with updateItem=false leaves items untouched; manual edits are never deduplicated', () => {
    expect(priceRecord('100', 'manual', 3, undefined, {updateItem: false})).toMatchObject({recorded: true, priceDate: null});
    expect(priceRecord('100', 'manual', 3, undefined, {updateItem: false})).toMatchObject({recorded: true});
    expect(itemsGetAll()[0]).toMatchObject({price: 0, priceDate: 0});
    expect(pricesExport(0, Number.MAX_SAFE_INTEGER)).toHaveLength(2);
  });

  it('leagues: insertUser and setStart for user rows', () => {
    const league = leaguesInsertUser('Mine', 500);
    expect(league).toEqual({id: 'user-500', name: 'Mine', startsAt: 500, source: 'user'});
    expect(leaguesSetStart('user-500', 600)).toBe(true);
    expect(leaguesSetStart('missing', 1)).toBe(false);
    expect(leaguesGetAll()).toEqual([{...league, startsAt: 600}]);
  });
});
