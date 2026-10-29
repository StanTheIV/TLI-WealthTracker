import {create} from 'zustand';
import type {ItemFilter, FilterRule} from '@/shared/item-filter';

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
// Store
// ---------------------------------------------------------------------------

/**
 * The stored filters. Every action is an optimistic local change plus its
 * write through main; main re-applies the stored active filter to the engine
 * after each write, so nothing here talks to the engine.
 */
export const useFilterStore = create<FilterState & FilterActions>((set, get) => {
  /** A rejected write re-syncs the store from main, so the UI never keeps a
   *  filter the DB doesn't have. */
  const persist = (write: Promise<void>): void => {
    write
      .catch(async (err: unknown) => {
        console.error('[filters] write failed:', err);
        await get().load();
      })
      .catch((err: unknown) => console.error('[filters] re-sync failed:', err));
  };

  /** Replace filter `id` with `fn(filter)` and write it; a no-op for an unknown id. */
  const updateFilter = (id: string, fn: (filter: ItemFilter) => ItemFilter): void => {
    const target = get().filters.find(f => f.id === id);
    if (!target) return;
    const updated = fn(target);
    set(s => ({filters: s.filters.map(f => f.id === id ? updated : f)}));
    persist(window.electronAPI.db.filters.update(updated));
  };

  return {
    filters:  [],
    isLoaded: false,

    load: async () => {
      const filters = await window.electronAPI.db.filters.getAll();
      set({filters, isLoaded: true});
    },

    createFilter: (name) => {
      const filter: ItemFilter = {
        id:      crypto.randomUUID(),
        name,
        rules:   [],
        enabled: false,
      };
      set(s => ({filters: [...s.filters, filter]}));
      persist(window.electronAPI.db.filters.insert(filter));
    },

    deleteFilter: (id) => {
      set(s => ({filters: s.filters.filter(f => f.id !== id)}));
      persist(window.electronAPI.db.filters.delete(id));
    },

    renameFilter: (id, name) => {
      updateFilter(id, f => ({...f, name}));
    },

    enableFilter: (id) => {
      set(s => ({filters: s.filters.map(f => ({...f, enabled: f.id === id}))}));
      persist(window.electronAPI.db.filters.setEnabled(id, true));
    },

    disableFilter: (id) => {
      set(s => ({filters: s.filters.map(f => f.id === id ? {...f, enabled: false} : f)}));
      persist(window.electronAPI.db.filters.setEnabled(id, false));
    },

    addRule: (filterId, rule) => {
      updateFilter(filterId, f => ({...f, rules: [...f.rules, rule]}));
    },

    removeRule: (filterId, ruleId) => {
      updateFilter(filterId, f => ({...f, rules: f.rules.filter(r => r.id !== ruleId)}));
    },

    updateRule: (filterId, ruleId, patch) => {
      updateFilter(filterId, f => ({...f, rules: f.rules.map(r => r.id === ruleId ? {...r, ...patch} : r)}));
    },

    reorderRules: (filterId, orderedIds) => {
      updateFilter(filterId, f => {
        const ruleMap = new Map(f.rules.map(r => [r.id, r]));
        return {...f, rules: orderedIds.map(id => ruleMap.get(id)).filter((r): r is FilterRule => r != null)};
      });
    },
  };
});
