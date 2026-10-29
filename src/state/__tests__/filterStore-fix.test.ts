/**
 * A re-sync load() never applies a getAll snapshot that predates a write made while it was in flight:
 * it discards it and asks again, so the store keeps every filter main stored.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {ItemFilter} from '@/shared/item-filter';

describe('filterStore - re-sync load() vs a newer optimistic write', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('a filter created while the re-sync getAll is in flight is not erased when that older snapshot lands', async () => {
    let db: ItemFilter[] = [{id: 'a', name: 'A', enabled: false, rules: []}];
    const pendingGetAll: Array<() => void> = [];
    let updates = 0;
    const filters = {
      // The snapshot is taken when main PROCESSES the call; the reply is delivered later.
      getAll: vi.fn(() => { const snap = structuredClone(db); return new Promise<ItemFilter[]>(res => pendingGetAll.push(() => res(snap))); }),
      insert: vi.fn((f: ItemFilter) => { db.push(structuredClone(f)); return Promise.resolve(); }),
      update: vi.fn(() => (++updates === 1 ? Promise.reject(new Error('refused')) : Promise.resolve())),
      delete: vi.fn(() => Promise.resolve()),
      setEnabled: vi.fn(() => Promise.resolve()),
    };
    vi.resetModules();
    vi.stubGlobal('window', {electronAPI: {db: {filters}}});
    const {useFilterStore} = await import('@/state/filterStore');

    const initial = useFilterStore.getState().load();
    pendingGetAll.shift()!();
    await initial;

    useFilterStore.getState().renameFilter('a', 'A2');        // refused -> re-sync load() starts
    await vi.waitFor(() => expect(pendingGetAll).toHaveLength(1));

    useFilterStore.getState().createFilter('Fresh');           // main stores it AFTER the snapshot was taken
    expect(db.map(f => f.name)).toContain('Fresh');
    pendingGetAll.shift()!();                                  // the older snapshot arrives
    await new Promise(r => setTimeout(r, 0));

    expect(useFilterStore.getState().filters.map(f => f.id).sort()).toEqual(db.map(f => f.id).sort());
  });
});
