import {describe, it, expect} from 'vitest';
import {includesItem, type ItemTypeOf} from '../item-filter';
import type {FilterRule} from '@/shared/item-filter';
import type {ItemType} from '@/shared/items';

let n = 0;
function rule(action: FilterRule['action'], kind: FilterRule['kind'], scopes: FilterRule['scopes']): FilterRule {
  return {id: `r${++n}`, action, kind, scopes};
}

function types(entries: [string, ItemType][]): ItemTypeOf {
  const m = new Map(entries);
  return id => m.get(id);
}

const NONE = types([]);

describe('includesItem', () => {
  it('includes everything with no rules', () => {
    expect(includesItem([], NONE, '100', 'session')).toBe(true);
    expect(includesItem([], NONE, '100', 'wealth')).toBe(true);
  });

  it('includes an item no rule matches', () => {
    const rules = [rule('hide', {type: 'by-item', itemId: '100'}, ['wealth'])];
    expect(includesItem(rules, NONE, '200', 'wealth')).toBe(true);
  });

  it('by-item: hides only the named id, compared as a string', () => {
    const rules = [rule('hide', {type: 'by-item', itemId: '100'}, ['wealth'])];
    expect(includesItem(rules, NONE, '100', 'wealth')).toBe(false);
    expect(includesItem(rules, NONE, '1000', 'wealth')).toBe(true);
    expect(includesItem(rules, NONE, '10', 'wealth')).toBe(true);
  });

  it('by-type: matches the type typeOf reports', () => {
    const typeOf = types([['1', 'equipment'], ['2', 'cube']]);
    const rules  = [rule('hide', {type: 'by-type', itemType: 'equipment'}, ['wealth'])];
    expect(includesItem(rules, typeOf, '1', 'wealth')).toBe(false);
    expect(includesItem(rules, typeOf, '2', 'wealth')).toBe(true);
  });

  it("by-type: an unknown item counts as 'other'", () => {
    const hideOther = [rule('hide', {type: 'by-type', itemType: 'other'}, ['wealth'])];
    const hideCube  = [rule('hide', {type: 'by-type', itemType: 'cube'}, ['wealth'])];
    expect(includesItem(hideOther, NONE, '999', 'wealth')).toBe(false);
    expect(includesItem(hideCube, NONE, '999', 'wealth')).toBe(true);
  });

  it('only rules whose scopes include the scope are evaluated', () => {
    const rules = [rule('hide', {type: 'by-item', itemId: '100'}, ['session', 'map'])];
    expect(includesItem(rules, NONE, '100', 'session')).toBe(false);
    expect(includesItem(rules, NONE, '100', 'map')).toBe(false);
    expect(includesItem(rules, NONE, '100', 'wealth')).toBe(true);
    expect(includesItem(rules, NONE, '100', 'vorex')).toBe(true);
  });

  it('first matching rule wins: show before hide whitelists', () => {
    const typeOf = types([['1', 'equipment'], ['2', 'equipment']]);
    const rules  = [
      rule('show', {type: 'by-item', itemId: '1'}, ['wealth']),
      rule('hide', {type: 'by-type', itemType: 'equipment'}, ['wealth']),
    ];
    expect(includesItem(rules, typeOf, '1', 'wealth')).toBe(true);
    expect(includesItem(rules, typeOf, '2', 'wealth')).toBe(false);
  });

  it('first matching rule wins: hide before show hides', () => {
    const typeOf = types([['1', 'equipment']]);
    const rules  = [
      rule('hide', {type: 'by-type', itemType: 'equipment'}, ['wealth']),
      rule('show', {type: 'by-item', itemId: '1'}, ['wealth']),
    ];
    expect(includesItem(rules, typeOf, '1', 'wealth')).toBe(false);
  });

  it('an out-of-scope match does not shadow a later in-scope rule', () => {
    const rules = [
      rule('show', {type: 'by-item', itemId: '1'}, ['session']),
      rule('hide', {type: 'by-item', itemId: '1'}, ['wealth']),
    ];
    expect(includesItem(rules, NONE, '1', 'wealth')).toBe(false);
    expect(includesItem(rules, NONE, '1', 'session')).toBe(true);
  });

  it('a rule kind this build does not know matches nothing', () => {
    const unknown = {id: 'x', action: 'hide', kind: {type: 'by-name', name: 'a'}, scopes: ['wealth']} as unknown as FilterRule;
    expect(includesItem([unknown], NONE, '1', 'wealth')).toBe(true);
  });

  it('reads types through typeOf at call time', () => {
    const m = new Map<string, ItemType>();
    const rules = [rule('hide', {type: 'by-type', itemType: 'card'}, ['wealth'])];
    expect(includesItem(rules, id => m.get(id), '1', 'wealth')).toBe(true);
    m.set('1', 'card');
    expect(includesItem(rules, id => m.get(id), '1', 'wealth')).toBe(false);
  });
});
