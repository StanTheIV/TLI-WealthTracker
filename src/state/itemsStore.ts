import {create} from 'zustand';
import type {DbItem} from '@/types/electron';

interface ItemsState {
  items:        Record<string, DbItem>;
  isLoaded:     boolean;
  lookupsToday: number;
}

interface ItemsActions {
  load:            () => Promise<void>;
  upsert:          (item: DbItem) => void;
  setName:         (id: string, name: string) => void;
  setType:         (id: string, type: string) => void;
  setPrice:        (id: string, price: number) => void;
  lookupName:      (id: string) => Promise<{error?: string; name?: string | null}>;
  loadLookupsToday:() => Promise<void>;
}

export const useItemsStore = create<ItemsState & ItemsActions>((set, get) => ({
  items:        {},
  isLoaded:     false,
  lookupsToday: 0,

  load: async () => {
    const rows = await window.electronAPI.db.items.getAll();
    const items = Object.fromEntries(rows.map(r => [r.id, r]));
    const lookupsToday = await window.electronAPI.db.lookups.getToday();
    set({items, isLoaded: true, lookupsToday});
  },

  upsert: (item) => {
    window.electronAPI.db.items.upsert(item);
    set({items: {...get().items, [item.id]: item}});
  },

  setName: (id, name) => {
    window.electronAPI.db.items.setName(id, name);
    const existing = get().items[id];
    if (existing) set({items: {...get().items, [id]: {...existing, name}}});
  },

  setType: (id, type) => {
    window.electronAPI.db.items.setType(id, type);
    window.electronAPI.engine.updateItemType(id, type);
    const existing = get().items[id];
    if (existing) set({items: {...get().items, [id]: {...existing, type}}});
  },

  setPrice: (id, price) => {
    window.electronAPI.db.items.setPrice(id, price);
    const existing = get().items[id];
    if (existing) set({items: {...get().items, [id]: {...existing, price}}});
  },

  loadLookupsToday: async () => {
    const lookupsToday = await window.electronAPI.db.lookups.getToday();
    set({lookupsToday});
  },

  lookupName: async (id) => {
    const result = await window.electronAPI.db.items.lookupName(id);
    set({lookupsToday: result.lookupsToday});
    if ('error' in result) return {error: result.error};
    const existing = get().items[id];
    if (existing) {
      const updates: Partial<typeof existing> = {};
      if (result.name)                    updates.name = result.name;
      if (result.type && result.type !== 'other')  updates.type = result.type;
      if (Object.keys(updates).length > 0)
        set({items: {...get().items, [id]: {...existing, ...updates}}});
    }
    if (result.name)                              window.electronAPI.db.items.setName(id, result.name);
    if (result.type && result.type !== 'other' && existing) {
      window.electronAPI.db.items.setType(id, result.type);
      window.electronAPI.engine.updateItemType(id, result.type);
    }
    return {name: result.name};
  },
}));
