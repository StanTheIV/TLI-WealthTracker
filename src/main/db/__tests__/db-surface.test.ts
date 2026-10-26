/**
 * Remaining db.ts exports on the node:sqlite driver (db.test.ts covers the
 * transaction sites). Together the two files exercise every exported function.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {
  initDb, getDb, itemsCount, itemsGetAll, itemsImportBatch, itemsSetName, itemsSetType, itemsSetPrice,
  itemsSetLocked, itemsGetLocked, getLookupCountToday, recordLookup,
  sessionsGetAll, sessionsInsert, sessionsUpdate, sessionsDelete, sessionsRename, sessionsGetOne,
  sessionMapsInsert, sessionMapsGetForSession, sessionMapsDeleteForSession,
  seasonalStatsGetAll, seasonalStatsUpsert,
  wealthInsert, wealthGetRange, wealthGetLatest, wealthDelete,
  filtersInsert, filtersUpdate, filtersDelete, filtersGetAll,
  priceRecord, pricesHistory, pricesMovers, pricesExport,
  leaguesInsertUser, leaguesGetAll, leaguesSetStart,
} from '@/main/db';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

const session = (id: string, savedAt: string, extra: Partial<DbSession> = {}): DbSession => ({
  id, name: id, savedAt, totalTime: 1, mapTime: 1, mapCount: 1,
  drops: {'100': 1}, dropsBySource: {map: {'100': 1}}, attribution: 'drop-through', priceSnapshot: {}, ...extra,
});

const mapRow = (sessionId: string, mapIndex: number): DbSessionMap => ({
  sessionId, mapIndex, startedAt: mapIndex, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null,
});

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

  it('sessions: getAll ordering, update, rename, delete cascades to maps', () => {
    sessionsInsert(session('a', '2026-10-01T00:00:00Z'));
    sessionsInsert(session('b', '2026-10-02T00:00:00Z'));
    expect(sessionsGetAll().map(s => s.id)).toEqual(['b', 'a']);

    sessionsUpdate({...session('a', '2026-10-03T00:00:00Z'), name: 'renamed-by-update', drops: {'200': 9}, priceSnapshot: {'200': 1}});
    expect(sessionsGetOne('a')).toMatchObject({name: 'renamed-by-update', savedAt: '2026-10-03T00:00:00Z', drops: {'200': 9}, priceSnapshot: {'200': 1}});
    expect(sessionsGetAll().map(s => s.id)).toEqual(['a', 'b']);

    sessionsRename('b', 'Bee');
    expect(sessionsGetOne('b')?.name).toBe('Bee');

    sessionMapsInsert([mapRow('a', 0), mapRow('b', 0), mapRow('b', 1)]);
    sessionMapsDeleteForSession('b');
    expect(sessionMapsGetForSession('b')).toEqual([]);
    expect(sessionMapsGetForSession('a')).toHaveLength(1);

    sessionMapsInsert([mapRow('b', 0)]);
    sessionsDelete('b');
    expect(sessionsGetOne('b')).toBeNull();
    expect(sessionMapsGetForSession('b')).toEqual([]);
    expect(sessionMapsGetForSession('a')).toHaveLength(1);
    sessionMapsInsert([]);   // empty batch is a no-op
  });

  it('a legacy row (attribution empty, no drops_by_source) is classified at read time', () => {
    const conn = getDb();
    conn.prepare("INSERT INTO sessions (id, name, saved_at, drops) VALUES ('old', 'Old', 'x', '{}')").run();
    conn.prepare(`INSERT INTO sessions (id, name, saved_at, drops, drops_by_source) VALUES ('mid', 'Mid', 'y', '{}', '{"map":{"1":1}}')`).run();
    expect(sessionsGetOne('old')).toMatchObject({attribution: 'legacy', dropsBySource: {}, priceSnapshot: {}});
    expect(sessionsGetOne('mid')?.attribution).toBe('exclusive');
  });

  it('seasonal stats upsert replaces by zone type', () => {
    expect(seasonalStatsGetAll()).toEqual([]);
    seasonalStatsUpsert({zoneType: 'arcana', zoneCount: 1, totalTime: 10, totalIncome: 5, dropList: {'100': 1}});
    seasonalStatsUpsert({zoneType: 'arcana', zoneCount: 2, totalTime: 20, totalIncome: 9, dropList: {'100': 3}});
    seasonalStatsUpsert({zoneType: 'vorex',  zoneCount: 1, totalTime: 1,  totalIncome: 1, dropList: {}});
    const all = seasonalStatsGetAll().sort((a, b) => a.zoneType.localeCompare(b.zoneType));
    expect(all).toEqual([
      {zoneType: 'arcana', zoneCount: 2, totalTime: 20, totalIncome: 9, dropList: {'100': 3}},
      {zoneType: 'vorex',  zoneCount: 1, totalTime: 1,  totalIncome: 1, dropList: {}},
    ]);
  });

  it('wealth: range is inclusive and ordered, latest is the tail in ascending order, delete removes one', () => {
    for (const t of [30, 10, 20, 40]) wealthInsert({timestamp: t, value: t * 2, sessionId: t === 20 ? 's1' : null, breakdown: '{}'});
    expect(wealthGetRange(10, 30).map(p => p.timestamp)).toEqual([10, 20, 30]);
    expect(wealthGetRange(10, 30)[1]).toMatchObject({value: 40, sessionId: 's1', breakdown: '{}'});
    expect(wealthGetRange(10, 30)[0].sessionId).toBeNull();
    expect(wealthGetLatest(2).map(p => p.timestamp)).toEqual([30, 40]);
    const id = wealthGetRange(20, 20)[0].id!;
    expect(typeof id).toBe('number');
    wealthDelete(id);
    expect(wealthGetRange(0, 100).map(p => p.timestamp)).toEqual([10, 30, 40]);
  });

  it('filters: insert, update, delete', () => {
    filtersInsert({id: 'f1', name: 'A', enabled: false, rules: '[]'});
    filtersInsert({id: 'f2', name: 'B', enabled: true,  rules: '[1]'});
    filtersUpdate({id: 'f1', name: 'A2', enabled: true, rules: '[2]'});
    expect(filtersGetAll()).toEqual([
      {id: 'f1', name: 'A2', enabled: true, rules: '[2]'},
      {id: 'f2', name: 'B',  enabled: true, rules: '[1]'},
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
