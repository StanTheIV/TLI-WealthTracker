import type {FilterRule, FilterScope} from '@/types/itemFilter';
import type {ItemType} from '@/types/itemType';

/**
 * ItemFilterEngine — evaluates ordered filter rules against (itemId, scope) pairs.
 *
 * Rules are checked top-to-bottom; the first matching rule's action wins.
 * If no rule matches, the item is included (default: show).
 *
 * Lives in the main process only — the renderer pushes updated rule lists via IPC.
 */
export class ItemFilterEngine {
  private _rules:     FilterRule[];
  private _itemTypes: Map<string, ItemType>;

  constructor(rules: FilterRule[], itemTypes: Map<string, ItemType>) {
    this._rules     = rules;
    this._itemTypes = itemTypes;
  }

  /** Replace the rule list (e.g. when user changes active filter mid-session). */
  setRules(rules: FilterRule[]): void {
    this._rules = rules;
  }

  /** Cache item-type mapping as new items are discovered. */
  setItemType(itemId: string, type: ItemType): void {
    this._itemTypes.set(itemId, type);
  }

  /**
   * Returns true if the item should be tracked in the given scope.
   * Walks rules in order; first match wins. Default: true (show).
   */
  shouldInclude(itemId: number, scope: FilterScope): boolean {
    const idStr = String(itemId);
    for (const rule of this._rules) {
      if (!rule.scopes.includes(scope)) continue;
      if (this._matches(rule, idStr)) return rule.action === 'show';
    }
    return true;
  }

  private _matches(rule: FilterRule, idStr: string): boolean {
    if (rule.kind.type === 'by-item') {
      return rule.kind.itemId === idStr;
    }
    if (rule.kind.type === 'by-type') {
      const type = this._itemTypes.get(idStr) ?? 'other';
      return type === rule.kind.itemType;
    }
    return false;
  }
}
