import {describe, expect, it} from 'vitest';
import {breakdownChipTypes, keepShownChips} from '../breakdownChips';
import {ITEM_TYPES} from '@/shared/items';

describe('breakdownChipTypes', () => {
  it('offers only the types present among the rows, in ITEM_TYPES order', () => {
    const [first, second, third] = ITEM_TYPES.filter(type => type !== 'other');
    expect(breakdownChipTypes([third, first, third])).toEqual([first, third]);
    expect(breakdownChipTypes([second])).toEqual([second]);
  });

  it("never offers 'other', unknown or empty types", () => {
    const [first] = ITEM_TYPES.filter(type => type !== 'other');
    expect(breakdownChipTypes(['other', '', 'not-a-type', first])).toEqual([first]);
  });

  it('offers nothing for no rows', () => {
    expect(breakdownChipTypes([])).toEqual([]);
  });

  it('offers every non-other type when all are present', () => {
    expect(breakdownChipTypes(ITEM_TYPES)).toEqual(ITEM_TYPES.filter(type => type !== 'other'));
  });
});

describe('keepShownChips', () => {
  it('returns the same selection when every selected chip is shown', () => {
    const selected = new Set(['a', 'b']);
    expect(keepShownChips(selected, ['a', 'b', 'c'])).toBe(selected);
    const none = new Set<string>();
    expect(keepShownChips(none, [])).toBe(none);
  });

  it('drops selected chips that are no longer shown', () => {
    const selected = new Set(['a', 'b', 'c']);
    const kept = keepShownChips(selected, ['b']);
    expect(kept).not.toBe(selected);
    expect([...kept]).toEqual(['b']);
    expect([...selected]).toEqual(['a', 'b', 'c']);
  });

  it('clears the selection when no chip is shown', () => {
    expect([...keepShownChips(new Set(['a']), [])]).toEqual([]);
  });
});
