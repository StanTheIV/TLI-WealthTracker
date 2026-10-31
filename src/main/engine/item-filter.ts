import type {FilterRule, FilterScope} from '@/shared/item-filter';
import type {ItemType} from '@/shared/items';
import {includesItem, type ItemTypeOf} from '@/domain/item-filter';

/**
 * ItemFilterEngine — the engine's active filter: its rule list plus the shared,
 * mutable item-type map, evaluated by the pure `includesItem`.
 * Lives in the main process only — the renderer pushes updated rule lists via IPC.
 */
export class ItemFilterEngine {
  private _rules:     FilterRule[];
  private _itemTypes: Map<string, ItemType>;
  private readonly _typeOf: ItemTypeOf = id => this._itemTypes.get(id);

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
    return includesItem(this._rules, this._typeOf, String(itemId), scope);
  }
}
