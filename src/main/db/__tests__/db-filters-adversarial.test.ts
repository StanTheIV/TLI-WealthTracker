/** 5.1b adversarial: db.ts filters - round trips, corrupt rows, double-enabled rows. */
import {describe, it, expect, beforeEach} from 'vitest';
import {
  initDb, getDb, filtersGetAll, filtersInsert, filtersUpdate, filtersDelete, filtersSetEnabled,
} from '@/main/db';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import type {FilterRule, ItemFilter} from '@/shared/item-filter';

const RULES: FilterRule[] = [
  {id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session', 'wealth']},
  {id: 'r2', action: 'show', kind: {type: 'by-item', itemId: '100'},    scopes: []},
];
const filter = (over: Partial<ItemFilter> = {}): ItemFilter => ({id: 'f1', name: 'F', enabled: false, rules: RULES, ...over});
const raw = (id: string, rules: string, enabled = 0) =>
  getDb().prepare('INSERT INTO item_filters (id, name, enabled, rules) VALUES (?, ?, ?, ?)').run(id, id, enabled, rules);
const stored = () => getDb().prepare('SELECT id, rules FROM item_filters ORDER BY rowid').all() as {id: string; rules: string}[];

beforeEach(() => {
  initDb(openNodeSqlite(), {backup: () => {}});
});

describe('round trip identity', () => {
  it('insert -> get, update -> get, setEnabled -> get, delete -> get all return exactly what was written', () => {
    const a = filter({id: 'a', name: 'A'});
    const b = filter({id: 'b', name: 'B', rules: []});
    filtersInsert(a);
    filtersInsert(b);
    expect(filtersGetAll()).toEqual([a, b]);

    const a2 = {...a, name: 'A2', rules: [RULES[1]]};
    filtersUpdate(a2);
    expect(filtersGetAll()).toEqual([a2, b]);

    filtersSetEnabled('b', true);
    expect(filtersGetAll()).toEqual([{...a2, enabled: false}, {...b, enabled: true}]);
    filtersSetEnabled('a', true);
    expect(filtersGetAll().map(f => f.enabled)).toEqual([true, false]);
    filtersSetEnabled('a', false);
    expect(filtersGetAll().map(f => f.enabled)).toEqual([false, false]);

    filtersDelete('a');
    expect(filtersGetAll().map(f => f.id)).toEqual(['b']);
  });

  it('the returned rules never alias a later read (fresh decode per call)', () => {
    filtersInsert(filter());
    const first = filtersGetAll();
    first[0].rules[0].scopes.push('map');
    expect(filtersGetAll()[0].rules).toEqual(RULES);
  });

  it('insert does not retain the caller\'s array: mutating it afterwards does not change what is stored', () => {
    const f = filter({rules: structuredClone(RULES)});
    filtersInsert(f);
    f.rules[0].scopes.push('map');
    expect(filtersGetAll()[0].rules).toEqual(RULES);
  });

  it('unknown scope / itemType strings (newer app version) round-trip untouched', () => {
    const rules = [{id: 'x', action: 'hide', kind: {type: 'by-type', itemType: 'future-type'}, scopes: ['future-scope']}] as unknown as FilterRule[];
    filtersInsert(filter({rules}));
    expect(filtersGetAll()[0].rules).toEqual(rules);
  });
});

describe('writes of malformed rules', () => {
  it.each<[string, unknown]>([
    ['a JSON string', '[]'],
    ['null', null],
    ['an object', {}],
    ['a rule missing its kind', [{id: 'r', action: 'hide', scopes: []}]],
  ])('insert of %s throws and stores nothing', (_n, rules) => {
    expect(() => filtersInsert(filter({rules: rules as never}))).toThrow();
    expect(stored()).toEqual([]);
  });

  it('update with malformed rules throws and leaves the stored row untouched', () => {
    filtersInsert(filter());
    const before = stored();
    expect(() => filtersUpdate(filter({name: 'changed', rules: 'x' as never}))).toThrow();
    expect(stored()).toEqual(before);
    expect(filtersGetAll()[0].name).toBe('F');
  });

  it('update / delete / setEnabled of a non-existent id are silent no-ops', () => {
    filtersInsert(filter());
    expect(() => filtersUpdate(filter({id: 'ghost', name: 'G'}))).not.toThrow();
    expect(() => filtersDelete('ghost')).not.toThrow();
    expect(filtersGetAll()).toEqual([filter()]);
    // setEnabled(ghost, true) disables everything: the one enabled row is lost, nothing is enabled.
    filtersSetEnabled('f1', true);
    expect(() => filtersSetEnabled('ghost', true)).not.toThrow();
    expect(filtersGetAll().every(f => !f.enabled)).toBe(true);
  });

  it('a hostile id / name (SQL metacharacters) is bound, not interpolated', () => {
    const f = filter({id: "x'); DROP TABLE item_filters;--", name: "n'; --"});
    filtersInsert(f);
    expect(filtersGetAll()).toEqual([f]);
  });
});

describe('corrupt and duplicate rows', () => {
  it('a corrupt row among valid ones makes the whole read throw, naming only the bad filter', () => {
    filtersInsert(filter({id: 'good1'}));
    raw('bad', '[{"id":1}]');
    filtersInsert(filter({id: 'good2'}));
    expect(() => filtersGetAll()).toThrow(/Filter bad has unreadable rules/);
  });

  it.each(['', 'not json', 'null', '{}', '"x"', '[null]', '[[]]', '{"length":0}'])('stored rules %j: reading throws', (json) => {
    raw('bad', json);
    expect(() => filtersGetAll()).toThrow(/Filter bad has unreadable rules/);
  });

  it('the corrupt row can still be repaired by update and deleted, then reads work again', () => {
    raw('bad', 'junk');
    filtersUpdate(filter({id: 'bad', rules: RULES}));
    expect(filtersGetAll()).toHaveLength(1);
    raw('bad2', 'junk');
    filtersDelete('bad2');
    expect(filtersGetAll()).toHaveLength(1);
  });

  it('two enabled rows written by raw SQL: getAll returns both in rowid order; first-enabled wins consistently for every consumer', () => {
    raw('first', JSON.stringify([RULES[0]]), 1);
    raw('second', JSON.stringify([RULES[1]]), 1);
    const all = filtersGetAll();
    expect(all.map(f => [f.id, f.enabled])).toEqual([['first', true], ['second', true]]);
    // TrackingService._activeFilter and WealthSeries._activeRules both use find(enabled): the same row.
    expect(all.find(f => f.enabled)?.id).toBe('first');
  });

  it('insert/update with enabled:true does not demote an already-enabled row (only setEnabled keeps the invariant)', () => {
    filtersInsert(filter({id: 'a', enabled: true}));
    filtersInsert(filter({id: 'b', enabled: true}));
    expect(filtersGetAll().filter(f => f.enabled).map(f => f.id)).toEqual(['a', 'b']);
    // setEnabled repairs it
    filtersSetEnabled('b', true);
    expect(filtersGetAll().filter(f => f.enabled).map(f => f.id)).toEqual(['b']);
  });
});
