import {create} from 'zustand';
import type {DbItem, ItemChangedPatch} from '@/types/electron';

interface ItemsState {
  items:        Record<string, DbItem>;
  isLoaded:     boolean;
  lookupsToday: number;
}

interface ItemsActions {
  load:                  () => Promise<void>;
  initBroadcastListener: () => void;
  upsert:                (item: DbItem) => void;
  setName:               (id: string, name: string) => void;
  setType:               (id: string, type: string) => void;
  setPrice:              (id: string, price: number) => void;
  lookupName:            (id: string) => Promise<{error?: string; name?: string | null}>;
  loadLookupsToday:      () => Promise<void>;
  /** Apply a patch broadcast from the main process. Exposed for tests. */
  applyPatch:            (patch: ItemChangedPatch) => void;
}

let _broadcastInitialized = false;

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

  /**
   * Subscribe to items:changed patches broadcast by the main process whenever
   * any item is mutated (in any window). Idempotent — safe to call twice.
   */
  initBroadcastListener: () => {
    if (_broadcastInitialized) return;
    _broadcastInitialized = true;
    window.electronAPI.db.items.onChanged((patch) => get().applyPatch(patch));
  },

  applyPatch: (patch) => {
    const existing = get().items[patch.id];
    // If we don't yet have a row for this id (newly discovered, race with
    // load), create a minimal one so the patch's price/name is preserved.
    const base: DbItem = existing ?? {id: patch.id, name: '', type: 'other', price: 0, priceDate: 0};
    set({items: {...get().items, [patch.id]: {...base, ...patch.changes}}});
  },

  // ---------------------------------------------------------------------
  // Mutators — fire-and-forget IPC calls. Local state updates arrive via
  // the items:changed broadcast (set up by initBroadcastListener), so
  // every window stays in sync regardless of which one initiated the change.
  // ---------------------------------------------------------------------

  upsert:   (item)        => { window.electronAPI.db.items.upsert(item); },
  setName:  (id, name)    => { window.electronAPI.db.items.setName(id, name); },
  setType:  (id, type)    => { window.electronAPI.db.items.setType(id, type); },
  setPrice: (id, price)   => { window.electronAPI.db.items.setPrice(id, price); },

  loadLookupsToday: async () => {
    const lookupsToday = await window.electronAPI.db.lookups.getToday();
    set({lookupsToday});
  },

  lookupName: async (id) => {
    const result = await window.electronAPI.db.items.lookupName(id);
    set({lookupsToday: result.lookupsToday});
    if ('error' in result) return {error: result.error};
    // Main-process lookupName already wrote to DB and broadcast the patch,
    // so the local store will update via items:changed. Just return.
    return {name: result.name};
  },
}));
