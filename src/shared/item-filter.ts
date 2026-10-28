import type {ItemType} from './items';
import {MECHANICS, type SeasonalType} from './mechanics';

export type FilterScope = 'session' | 'map' | SeasonalType | 'wealth';
/** Chip render order: the tiers, every mechanic in table order, then wealth. */
export const FILTER_SCOPES: readonly FilterScope[] = ['session', 'map', ...MECHANICS.map(m => m.key), 'wealth'];

export type RuleAction = 'show' | 'hide';

export type RuleKind =
  | { type: 'by-type'; itemType: ItemType }
  | { type: 'by-item'; itemId: string };

export interface FilterRule {
  id:     string;
  action: RuleAction;
  kind:   RuleKind;
  scopes: FilterScope[];
}

export interface ItemFilter {
  id:      string;
  name:    string;
  rules:   FilterRule[];
  enabled: boolean;
}
