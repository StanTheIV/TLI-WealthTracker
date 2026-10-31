/**
 * db.ts filter writes keep every stored row readable and "at most one enabled filter" true by
 * construction: a sparse rules payload is rejected at write time, and an enabled insert/update
 * disables every other row (not only filtersSetEnabled).
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {initDb, filtersGetAll, filtersInsert, filtersUpdate} from '@/main/db';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import type {FilterRule, ItemFilter} from '@/shared/item-filter';

const RULE: FilterRule = {id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session']};
const filter = (over: Partial<ItemFilter> = {}): ItemFilter => ({id: 'f', name: 'F', enabled: false, rules: [], ...over});
const enabledIds = () => filtersGetAll().filter(f => f.enabled).map(f => f.id);

beforeEach(() => {
  initDb(openNodeSqlite(), {backup: () => {}});
});

describe('filtersInsert - a malformed payload is rejected, never stored', () => {
  it('a rules list with a hole is rejected at write time (filtersGetAll stays readable)', () => {
    const sparse = [, RULE] as unknown as FilterRule[];
    try { filtersInsert({id: 'f', name: 'F', enabled: false, rules: sparse}); } catch { return; }
    expect(() => filtersGetAll()).not.toThrow();
  });

  it('scopes with a hole is rejected at write time (filtersGetAll stays readable)', () => {
    const scopes = ['session', , 'map'] as never;
    try { filtersInsert({id: 'f', name: 'F', enabled: false, rules: [{...RULE, scopes}]}); } catch { return; }
    expect(() => filtersGetAll()).not.toThrow();
  });
});

describe('one enabled filter by construction', () => {
  it('an insert with enabled:true disables the previously enabled row', () => {
    filtersInsert(filter({id: 'a', enabled: true}));
    filtersInsert(filter({id: 'b', enabled: true}));
    expect(enabledIds()).toEqual(['b']);
  });

  it('an update with enabled:true disables the previously enabled row', () => {
    filtersInsert(filter({id: 'a', enabled: true}));
    filtersInsert(filter({id: 'b'}));
    filtersUpdate(filter({id: 'b', name: 'B', enabled: true}));
    expect(enabledIds()).toEqual(['b']);
    expect(filtersGetAll().find(f => f.id === 'b')?.name).toBe('B');
  });

  it('a write with enabled:false leaves the enabled row alone', () => {
    filtersInsert(filter({id: 'a', enabled: true}));
    filtersInsert(filter({id: 'b'}));
    filtersUpdate(filter({id: 'b', name: 'B2'}));
    expect(enabledIds()).toEqual(['a']);
  });

  it('a failed insert (duplicate id) leaves the enabled row enabled (one transaction)', () => {
    filtersInsert(filter({id: 'a', enabled: true}));
    filtersInsert(filter({id: 'b'}));
    expect(() => filtersInsert(filter({id: 'b', enabled: true}))).toThrow();
    expect(enabledIds()).toEqual(['a']);
  });

  it('an update of an unknown id changes nothing (the enabled row stays enabled)', () => {
    filtersInsert(filter({id: 'a', enabled: true}));
    filtersUpdate(filter({id: 'ghost', enabled: true}));
    expect(enabledIds()).toEqual(['a']);
    expect(filtersGetAll().map(f => f.id)).toEqual(['a']);
  });

  it('a rejected rules payload changes nothing (the enabled row stays enabled)', () => {
    filtersInsert(filter({id: 'a', enabled: true}));
    filtersInsert(filter({id: 'b'}));
    expect(() => filtersUpdate(filter({id: 'b', enabled: true, rules: [null] as never}))).toThrow();
    expect(enabledIds()).toEqual(['a']);
  });
});
