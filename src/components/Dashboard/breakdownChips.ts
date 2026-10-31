import {ITEM_TYPES, type ItemType} from '@/shared/items';

/**
 * The type chips the Item Breakdown offers: every `ITEM_TYPES` entry (in that
 * order, never 'other') that at least one breakdown row carries. Main's rows are
 * already filter-pruned, so a type the active filter hides entirely gets no chip.
 */
export function breakdownChipTypes(rowTypes: Iterable<string>): ItemType[] {
  const present = new Set(rowTypes);
  return ITEM_TYPES.filter(type => type !== 'other' && present.has(type));
}

/**
 * The chip selection restricted to the chips currently shown. Returns `selected`
 * itself when nothing is dropped, so a caller can detect a change by identity.
 */
export function keepShownChips(selected: ReadonlySet<string>, shown: readonly string[]): ReadonlySet<string> {
  const kept = [...selected].filter(type => shown.includes(type));
  return kept.length === selected.size ? selected : new Set(kept);
}
