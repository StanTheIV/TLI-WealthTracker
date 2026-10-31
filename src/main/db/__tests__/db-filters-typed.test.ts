/** 5.1b: db.ts is the only filter JSON site — typed in, typed out, corruption throws. */
import {describe, it, expect, beforeEach} from 'vitest';
import {initDb, getDb, filtersGetAll, filtersInsert, filtersUpdate} from '@/main/db';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import type {FilterRule, ItemFilter} from '@/shared/item-filter';

const RULES: FilterRule[] = [
  {id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session', 'wealth']},
  {id: 'r2', action: 'show', kind: {type: 'by-item', itemId: '100'},    scopes: ['map']},
];
const filter = (over: Partial<ItemFilter> = {}): ItemFilter => ({id: 'f1', name: 'F', enabled: false, rules: RULES, ...over});
const raw = (id: string, rules: string, enabled = 0) =>
  getDb().prepare('INSERT INTO item_filters (id, name, enabled, rules) VALUES (?, ?, ?, ?)').run(id, id, enabled, rules);
const stored = () => getDb().prepare('SELECT id, rules FROM item_filters ORDER BY rowid').all() as {id: string; rules: string}[];

beforeEach(() => {
  initDb(openNodeSqlite(), {backup: () => {}});
});

describe('db filters — typed rules', () => {
  it('insert stores typed rules; getAll returns them as FilterRule[]', () => {
    filtersInsert(filter());
    const all = filtersGetAll();
    expect(all).toEqual([filter()]);
    expect(Array.isArray(all[0].rules)).toBe(true);
    expect(JSON.parse(stored()[0].rules)).toEqual(RULES);
  });

  it('update replaces the rules', () => {
    filtersInsert(filter());
    filtersUpdate(filter({name: 'G', enabled: true, rules: [RULES[1]]}));
    expect(filtersGetAll()).toEqual([filter({name: 'G', enabled: true, rules: [RULES[1]]})]);
  });

  it('an empty rule list round-trips', () => {
    filtersInsert(filter({rules: []}));
    expect(filtersGetAll()[0].rules).toEqual([]);
  });

  it('unparsable stored JSON makes getAll throw an Error naming the filter id', () => {
    raw('good', JSON.stringify(RULES));
    raw('broken-id', '{not json');
    expect(() => filtersGetAll()).toThrow(/broken-id/);
    expect(() => filtersGetAll()).toThrow(Error);
  });

  it.each([
    ['an object', '{"a":1}'],
    ['a bad rule', '[{"id":"x","action":"nope","kind":{"type":"by-item","itemId":"1"},"scopes":[]}]'],
    ['null', 'null'],
  ])('structurally bad stored JSON (%s) throws naming the id', (_n, json) => {
    raw('bad-row', json);
    expect(() => filtersGetAll()).toThrow(/bad-row/);
  });

  it('insert with malformed rules throws and stores nothing', () => {
    expect(() => filtersInsert(filter({rules: [{id: 'x', action: 'zap'}] as unknown as FilterRule[]}))).toThrow();
    expect(() => filtersInsert(filter({rules: 'not an array' as unknown as FilterRule[]}))).toThrow();
    expect(() => filtersInsert(filter({rules: '[]' as unknown as FilterRule[]}))).toThrow(); // legacy string payload is rejected
    expect(stored()).toEqual([]);
  });

  it('update with malformed rules throws and leaves the stored rules untouched', () => {
    raw('f1', JSON.stringify(RULES));
    const before = stored();
    expect(() => filtersUpdate(filter({name: 'X', rules: [null] as unknown as FilterRule[]}))).toThrow();
    expect(() => filtersUpdate(filter({name: 'X', rules: '[]' as unknown as FilterRule[]}))).toThrow(); // legacy string payload
    expect(stored()).toEqual(before);
    expect(filtersGetAll()[0].name).toBe('f1');
  });
});
