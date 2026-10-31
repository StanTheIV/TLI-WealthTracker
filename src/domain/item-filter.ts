import type {FilterRule, FilterScope} from '@/shared/item-filter';
import type {ItemType} from '@/shared/items';

/** An item's display type by id. `undefined` (an item not yet known) evaluates
 *  as 'other', the same bucket an unmapped raw type lands in. */
export type ItemTypeOf = (itemId: string) => ItemType | undefined;

/** Whether an item counts in `scope`: the first rule scoped to `scope` that
 *  matches decides (show → true, hide → false); no match → included. Shared by
 *  the engine (live tracking) and the wealth valuation (stored points). */
export function includesItem(
  rules:  readonly FilterRule[],
  typeOf: ItemTypeOf,
  itemId: string,
  scope:  FilterScope,
): boolean {
  for (const rule of rules) {
    if (!rule.scopes.includes(scope)) continue;
    if (matchesRule(rule, typeOf, itemId)) return rule.action === 'show';
  }
  return true;
}

function matchesRule(rule: FilterRule, typeOf: ItemTypeOf, itemId: string): boolean {
  if (rule.kind.type === 'by-item') return rule.kind.itemId === itemId;
  if (rule.kind.type === 'by-type') return (typeOf(itemId) ?? 'other') === rule.kind.itemType;
  // A rule kind this build doesn't know (rules are user-stored JSON) matches nothing.
  return false;
}
