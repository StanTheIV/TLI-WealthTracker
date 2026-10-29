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

const RULE_ACTIONS: readonly string[] = ['show', 'hide'] satisfies readonly RuleAction[];

/**
 * The one structural validator for filter rules: `value` is an already-parsed
 * rules list (stored JSON, an IPC payload). Throws a clear Error on any shape
 * violation; returns fresh rules carrying only the known fields. Value domains
 * stay lenient: an unknown scope or item type string passes (it never
 * matches) — a newer app version's rule must not break an older one.
 */
export function decodeFilterRules(value: unknown): FilterRule[] {
  if (!Array.isArray(value)) throw new Error(`Filter rules must be an array, got ${typeName(value)}`);
  return value.map((rule: unknown, i) => decodeRule(rule, i));
}

function decodeRule(rule: unknown, i: number): FilterRule {
  if (!isRecord(rule)) throw new Error(`Filter rule #${i} must be an object, got ${typeName(rule)}`);
  const {id, action, kind, scopes} = rule;
  if (typeof id !== 'string') throw new Error(`Filter rule #${i}: id must be a string, got ${typeName(id)}`);
  if (typeof action !== 'string' || !RULE_ACTIONS.includes(action)) {
    throw new Error(`Filter rule ${id}: action must be show or hide`);
  }
  if (!Array.isArray(scopes) || !scopes.every(s => typeof s === 'string')) {
    throw new Error(`Filter rule ${id}: scopes must be an array of strings`);
  }
  return {id, action: action as RuleAction, kind: decodeKind(kind, id), scopes: [...scopes] as FilterScope[]};
}

function decodeKind(kind: unknown, ruleId: string): RuleKind {
  if (!isRecord(kind)) throw new Error(`Filter rule ${ruleId}: kind must be an object, got ${typeName(kind)}`);
  if (kind.type === 'by-type') {
    if (typeof kind.itemType !== 'string') throw new Error(`Filter rule ${ruleId}: by-type kind needs a string itemType`);
    return {type: 'by-type', itemType: kind.itemType as ItemType};
  }
  if (kind.type === 'by-item') {
    if (typeof kind.itemId !== 'string') throw new Error(`Filter rule ${ruleId}: by-item kind needs a string itemId`);
    return {type: 'by-item', itemId: kind.itemId};
  }
  throw new Error(`Filter rule ${ruleId}: kind.type must be by-type or by-item`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value's kind for an error message — never the value itself (it may not stringify). */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}
