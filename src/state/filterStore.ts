import {create} from 'zustand';
import type {ItemFilter, FilterRule} from '@/types/itemFilter';

interface FilterState {
  filters:  ItemFilter[];
  isLoaded: boolean;
}

interface FilterActions {
  load:          () => Promise<void>;
  createFilter:  (name: string) => void;
  deleteFilter:  (id: string) => void;
  renameFilter:  (id: string, name: string) => void;
  enableFilter:  (id: string) => void;
  disableFilter: (id: string) => void;
  addRule:       (filterId: string, rule: FilterRule) => void;
  removeRule:    (filterId: string, ruleId: string) => void;
  updateRule:    (filterId: string, ruleId: string, patch: Partial<FilterRule>) => void;
  reorderRules:  (filterId: string, orderedIds: string[]) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize rules to JSON for DB storage. */
function encodeRules(rules: FilterRule[]): string {
  return JSON.stringify(rules);
}

/** Push the active filter's rules to the running engine. */
function pushToEngine(filters: ItemFilter[]): void {
  const active = filters.find(f => f.enabled);
  window.electronAPI.engine.updateFilterRules(active ? active.rules : null);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useFilterStore = create<FilterState & FilterActions>((set, get) => ({
  filters:  [],
  isLoaded: false,

  load: async () => {
    const rows = await window.electronAPI.db.filters.getAll();
    const filters: ItemFilter[] = rows.map(r => ({
      id:      r.id,
      name:    r.name,
      enabled: r.enabled,
      rules:   JSON.parse(r.rules) as FilterRule[],
    }));
    set({filters, isLoaded: true});
  },

  createFilter: (name) => {
    const filter: ItemFilter = {
      id:      crypto.randomUUID(),
      name,
      rules:   [],
      enabled: false,
    };
    window.electronAPI.db.filters.insert({...filter, rules: encodeRules(filter.rules)});
    set(s => ({filters: [...s.filters, filter]}));
  },

  deleteFilter: (id) => {
    window.electronAPI.db.filters.delete(id);
    set(s => {
      const filters = s.filters.filter(f => f.id !== id);
      pushToEngine(filters);
      return {filters};
    });
  },

  renameFilter: (id, name) => {
    set(s => {
      const filters = s.filters.map(f => f.id === id ? {...f, name} : f);
      const target  = filters.find(f => f.id === id);
      if (target) {
        window.electronAPI.db.filters.update({...target, rules: encodeRules(target.rules)});
      }
      return {filters};
    });
  },

  enableFilter: (id) => {
    window.electronAPI.db.filters.setEnabled(id, true);
    set(s => {
      const filters = s.filters.map(f => ({...f, enabled: f.id === id}));
      pushToEngine(filters);
      return {filters};
    });
  },

  disableFilter: (id) => {
    window.electronAPI.db.filters.setEnabled(id, false);
    set(s => {
      const filters = s.filters.map(f => f.id === id ? {...f, enabled: false} : f);
      pushToEngine(filters);
      return {filters};
    });
  },

  addRule: (filterId, rule) => {
    set(s => {
      const filters = s.filters.map(f => {
        if (f.id !== filterId) return f;
        const updated = {...f, rules: [...f.rules, rule]};
        window.electronAPI.db.filters.update({...updated, rules: encodeRules(updated.rules)});
        return updated;
      });
      pushToEngine(filters);
      return {filters};
    });
  },

  removeRule: (filterId, ruleId) => {
    set(s => {
      const filters = s.filters.map(f => {
        if (f.id !== filterId) return f;
        const updated = {...f, rules: f.rules.filter(r => r.id !== ruleId)};
        window.electronAPI.db.filters.update({...updated, rules: encodeRules(updated.rules)});
        return updated;
      });
      pushToEngine(filters);
      return {filters};
    });
  },

  updateRule: (filterId, ruleId, patch) => {
    set(s => {
      const filters = s.filters.map(f => {
        if (f.id !== filterId) return f;
        const updated = {...f, rules: f.rules.map(r => r.id === ruleId ? {...r, ...patch} : r)};
        window.electronAPI.db.filters.update({...updated, rules: encodeRules(updated.rules)});
        return updated;
      });
      pushToEngine(filters);
      return {filters};
    });
  },

  reorderRules: (filterId, orderedIds) => {
    set(s => {
      const filters = s.filters.map(f => {
        if (f.id !== filterId) return f;
        const ruleMap = new Map(f.rules.map(r => [r.id, r]));
        const reordered = orderedIds.map(id => ruleMap.get(id)).filter((r): r is FilterRule => r != null);
        const updated = {...f, rules: reordered};
        window.electronAPI.db.filters.update({...updated, rules: encodeRules(updated.rules)});
        return updated;
      });
      pushToEngine(filters);
      return {filters};
    });
  },
}));
