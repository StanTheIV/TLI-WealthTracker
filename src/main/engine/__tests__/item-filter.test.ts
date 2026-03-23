/**
 * Unit tests for ItemFilterEngine.
 *
 * Covers: rule ordering, first-match-wins, scope filtering,
 * by-type vs by-item matching, default-show, and setRules().
 */
import {describe, it, expect} from 'vitest';
import {ItemFilterEngine} from '@/main/engine/item-filter';
import type {FilterRule}   from '@/types/itemFilter';
import type {ItemType}     from '@/types/itemType';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(
  action: FilterRule['action'],
  kind:   FilterRule['kind'],
  scopes: FilterRule['scopes'],
): FilterRule {
  return {id: crypto.randomUUID(), action, kind, scopes};
}

function makeTypeMap(entries: [id: string, type: ItemType][]): Map<string, ItemType> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Default behaviour (no rules)
// ---------------------------------------------------------------------------

describe('ItemFilterEngine — no rules', () => {
  it('includes every item by default', () => {
    const f = new ItemFilterEngine([], new Map());
    expect(f.shouldInclude(100, 'session')).toBe(true);
    expect(f.shouldInclude(200, 'wealth')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// by-item rules
// ---------------------------------------------------------------------------

describe('ItemFilterEngine — by-item rules', () => {
  it('hides a specific item in the matching scope', () => {
    const f = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-item', itemId: '100'}, ['session'])],
      new Map(),
    );
    expect(f.shouldInclude(100, 'session')).toBe(false);
  });

  it('does not hide the item in an unrelated scope', () => {
    const f = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-item', itemId: '100'}, ['session'])],
      new Map(),
    );
    expect(f.shouldInclude(100, 'map')).toBe(true);
  });

  it('show rule on specific item overrides a hide rule for the same item', () => {
    // Rule 1: show item 100  — evaluated first
    // Rule 2: hide item 100  — never reached
    const f = new ItemFilterEngine(
      [
        makeRule('show', {type: 'by-item', itemId: '100'}, ['session']),
        makeRule('hide', {type: 'by-item', itemId: '100'}, ['session']),
      ],
      new Map(),
    );
    expect(f.shouldInclude(100, 'session')).toBe(true);
  });

  it('hides in all listed scopes when multiple scopes given', () => {
    const f = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-item', itemId: '100'}, ['session', 'map', 'wealth'])],
      new Map(),
    );
    expect(f.shouldInclude(100, 'session')).toBe(false);
    expect(f.shouldInclude(100, 'map')).toBe(false);
    expect(f.shouldInclude(100, 'wealth')).toBe(false);
    expect(f.shouldInclude(100, 'vorex')).toBe(true); // not listed
  });

  it('does not affect a different item', () => {
    const f = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-item', itemId: '100'}, ['session'])],
      new Map(),
    );
    expect(f.shouldInclude(999, 'session')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// by-type rules
// ---------------------------------------------------------------------------

describe('ItemFilterEngine — by-type rules', () => {
  it('hides all items of a given type', () => {
    const types = makeTypeMap([['100', 'equipment'], ['200', 'equipment'], ['300', 'cube']]);
    const f = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    );
    expect(f.shouldInclude(100, 'session')).toBe(false);
    expect(f.shouldInclude(200, 'session')).toBe(false);
    expect(f.shouldInclude(300, 'session')).toBe(true); // different type
  });

  it('items with unknown type default to "other"', () => {
    const types = makeTypeMap([]); // no mappings
    // "other" rule should match items not in the map
    const f = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'other'}, ['session'])],
      types,
    );
    expect(f.shouldInclude(999, 'session')).toBe(false);
  });

  it('does not hide items of a different type', () => {
    const types = makeTypeMap([['100', 'cube']]);
    const f = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    );
    expect(f.shouldInclude(100, 'session')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// First-match-wins / rule ordering (the main whitelist pattern)
// ---------------------------------------------------------------------------

describe('ItemFilterEngine — rule ordering', () => {
  it('whitelist pattern: show item 100 (equipment) before hide equipment rule', () => {
    /**
     * Common use-case from the plan:
     *   Rule 1 — Show item 100 (name)  → equipment, but explicitly shown
     *   Rule 2 — Hide type equipment   → hides all equipment except item 100
     */
    const types = makeTypeMap([['100', 'equipment'], ['200', 'equipment']]);
    const f = new ItemFilterEngine(
      [
        makeRule('show', {type: 'by-item',  itemId:   '100'},       ['session']),
        makeRule('hide', {type: 'by-type',  itemType: 'equipment'}, ['session']),
      ],
      types,
    );
    expect(f.shouldInclude(100, 'session')).toBe(true);  // whitelist wins
    expect(f.shouldInclude(200, 'session')).toBe(false); // type rule hits
  });

  it('reversing the rule order means hide-type takes precedence over show-item', () => {
    const types = makeTypeMap([['100', 'equipment']]);
    const f = new ItemFilterEngine(
      [
        makeRule('hide', {type: 'by-type',  itemType: 'equipment'}, ['session']),
        makeRule('show', {type: 'by-item',  itemId:   '100'},       ['session']),
      ],
      types,
    );
    // hide-type fires first → item 100 is hidden despite the show rule below it
    expect(f.shouldInclude(100, 'session')).toBe(false);
  });

  it('rules in an irrelevant scope are skipped even if they match', () => {
    const types = makeTypeMap([['100', 'equipment']]);
    const f = new ItemFilterEngine(
      [
        // Only applies to 'map', not 'session'
        makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['map']),
      ],
      types,
    );
    expect(f.shouldInclude(100, 'session')).toBe(true);
    expect(f.shouldInclude(100, 'map')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setRules() — live update
// ---------------------------------------------------------------------------

describe('ItemFilterEngine — setRules()', () => {
  it('replaces rule set mid-session and evaluates new rules immediately', () => {
    const types = makeTypeMap([['100', 'equipment']]);
    const f = new ItemFilterEngine([], types);

    // No rules → include
    expect(f.shouldInclude(100, 'session')).toBe(true);

    // Push a hide rule
    f.setRules([makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])]);
    expect(f.shouldInclude(100, 'session')).toBe(false);

    // Clear rules again
    f.setRules([]);
    expect(f.shouldInclude(100, 'session')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setItemType() — runtime type caching
// ---------------------------------------------------------------------------

describe('ItemFilterEngine — setItemType()', () => {
  it('newly cached type is applied on next shouldInclude call', () => {
    const f = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      new Map(), // item 100 not in map yet
    );

    // Not yet typed → defaults to 'other', so hide-equipment rule doesn't match
    expect(f.shouldInclude(100, 'session')).toBe(true);

    // Register the type
    f.setItemType('100', 'equipment');
    expect(f.shouldInclude(100, 'session')).toBe(false);
  });
});
