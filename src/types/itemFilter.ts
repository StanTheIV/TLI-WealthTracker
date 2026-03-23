import type {ItemType} from './itemType';

export type FilterScope = 'session' | 'map' | 'vorex' | 'dream' | 'overrealm' | 'wealth';
export const FILTER_SCOPES: FilterScope[] = ['session', 'map', 'vorex', 'dream', 'overrealm', 'wealth'];

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
