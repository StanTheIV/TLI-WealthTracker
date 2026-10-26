/**
 * db.ts on the SqlConn abstraction: initDb on a node:sqlite `:memory:` conn,
 * then a smoke round-trip through real query functions — covering every
 * transaction site.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {
  initDb, getDb, settingsSet, settingsGet, settingsGetAll,
  itemsImportBatch, itemsUpsert, itemsGetAll, itemsInsertIfMissing,
  wealthInsert, wealthGetLatest, wealthClear,
  filtersInsert, filtersSetEnabled, filtersGetAll,
  priceRecord, priceBackfillOnce, pricesExport,
  leaguesApply, leaguesGetAll, leaguesSetStart,
} from '@/main/db';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {DbItem, DbSession} from '@/shared/contracts/db';
import {openNodeSqlite} from '@/test/sql/node-sqlite';

const ITEMS: DbItem[] = [
  {id: '100', name: 'Ember',  type: 'ember', price: 2, priceDate: 1_700_000_000_000},
  {id: '200', name: 'Fossil', type: '',      price: 0, priceDate: 0},
];

const SESSION: DbSession = {
  id:            's1',
  name:          'Run',
  savedAt:       '2026-10-01T00:00:00.000Z',
  totalTime:     60_000,
  mapTime:       50_000,
  mapCount:      1,
  drops:         {'100': 3},
  dropsBySource: {map: {'100': 3}},
  attribution:   'drop-through',
  priceSnapshot: {'100': 2},
};

beforeEach(() => {
  initDb(openNodeSqlite(), {backup: () => { throw new Error('fresh DB must not back up'); }});
});

describe('db.ts on SqlConn', () => {
  it('initDb applies pragmas and migrations', () => {
    // :memory: can't do WAL; the pragma still runs without error.
    expect(getDb().getPragma('foreign_keys')).toBe(1);
    expect(getDb().getPragma('user_version')).toBe(1);
  });

  it('settings round-trip', () => {
    settingsSet('a', '1');
    settingsSet('a', '2');
    expect(settingsGet('a')).toBe('2');
    expect(settingsGet('missing')).toBeUndefined();
    expect(settingsGetAll()).toEqual({a: '2'});
  });

  it('itemsImportBatch inserts in one transaction and reports only new ids', () => {
    expect(itemsImportBatch(ITEMS)).toEqual(['100', '200']);
    expect(itemsImportBatch(ITEMS)).toEqual([]);
    expect(itemsInsertIfMissing('100')).toBe(false);
    expect(itemsInsertIfMissing('300')).toBe(true);
    // Extra keys (including a boolean `locked`) are ignored by the named binding.
    itemsUpsert({...ITEMS[0], price: 3, locked: true});
    expect(itemsGetAll().find(i => i.id === '100')).toMatchObject({price: 3, locked: false});
  });

  it('initDb normalises empty item types on every start', () => {
    itemsImportBatch(ITEMS);
    const conn = getDb();
    initDb(conn, {backup: vi.fn()});
    expect(itemsGetAll().find(i => i.id === '200')?.type).toBe('other');
  });

  it('wealthClear removes farming history in one transaction', () => {
    const sessions = new SqliteSessionStore(getDb());
    sessions.insertSession(SESSION);
    sessions.insertRows([{sessionId: 's1', mapIndex: 1, startedAt: 1, duration: 2, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null}]);
    wealthInsert({timestamp: 1, value: 10, sessionId: 's1', breakdown: '{}'});
    expect(wealthGetLatest(10)).toHaveLength(1);
    wealthClear();
    expect(wealthGetLatest(10)).toEqual([]);
    expect(sessions.getSession('s1')).toBeNull();
    expect(sessions.getRows('s1')).toEqual([]);
  });

  it('filtersSetEnabled leaves exactly one filter enabled', () => {
    filtersInsert({id: 'f1', name: 'A', enabled: true,  rules: '[]'});
    filtersInsert({id: 'f2', name: 'B', enabled: false, rules: '[]'});
    filtersSetEnabled('f2', true);
    expect(filtersGetAll().map(f => [f.id, f.enabled])).toEqual([['f1', false], ['f2', true]]);
    filtersSetEnabled('f2', false);
    expect(filtersGetAll().every(f => !f.enabled)).toBe(true);
  });

  it('priceRecord writes the observation, its listings and the item price atomically', () => {
    itemsImportBatch(ITEMS);
    const res = priceRecord('100', 'scrape', 5, [6, 4, 5], {updateItem: true});
    expect(res.recorded).toBe(true);
    expect(typeof res.priceDate).toBe('number');
    expect(itemsGetAll().find(i => i.id === '100')).toMatchObject({price: 5, priceDate: res.priceDate});
    const [obs] = pricesExport(0, Number.MAX_SAFE_INTEGER);
    expect(obs).toMatchObject({itemId: '100', source: 'scrape', price: 5, n: 3, min: 4});
    const listings = getDb().prepare('SELECT rank, price FROM price_listings ORDER BY rank').all();
    expect(listings).toEqual([{rank: 0, price: 4}, {rank: 1, price: 5}, {rank: 2, price: 6}]);

    // An immediate identical scrape is de-duplicated.
    expect(priceRecord('100', 'scrape', 5, [6, 4, 5], {updateItem: false})).toEqual({recorded: false, priceDate: null});
  });

  it('priceBackfillOnce runs once and sets its guard in the same transaction', () => {
    itemsImportBatch(ITEMS);
    const first = priceBackfillOnce();
    expect(first.skipped).toBe(false);
    expect(first.inserted).toBe(1);   // item 100's current price
    expect(settingsGet('price_backfill_done')).toBe('1');
    expect(priceBackfillOnce()).toEqual({inserted: 0, skipped: true});
  });

  it('leaguesApply upserts and deletes in one transaction', () => {
    leaguesApply({upserts: [{id: 'SS14', name: 'S14', startsAt: 1, source: 'bundled'}, {id: 'user-2', name: 'Mine', startsAt: 2, source: 'user'}], deletes: []});
    leaguesApply({upserts: [{id: 'SS14', name: 'Season 14', startsAt: 1, source: 'remote'}], deletes: ['user-2']});
    expect(leaguesGetAll()).toEqual([{id: 'SS14', name: 'Season 14', startsAt: 1, source: 'remote'}]);
    expect(leaguesSetStart('SS14', 5)).toBe(false);   // official rows are rejected
  });
});
