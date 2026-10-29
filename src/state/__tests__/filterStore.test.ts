/**
 * 5.1b: the renderer filterStore in Node — typed rules over IPC, no engine
 * push (main derives the engine's rules from the DB), a rejected write re-syncs.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {FilterRule, ItemFilter} from '@/shared/item-filter';

const RULE: FilterRule = {id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session']};
const ROWS: ItemFilter[] = [
  {id: 'a', name: 'A', enabled: true,  rules: [RULE]},
  {id: 'b', name: 'B', enabled: false, rules: []},
];

function stubApi(rows: ItemFilter[] = ROWS) {
  const filters = {
    getAll:     vi.fn(() => Promise.resolve(structuredClone(rows))),
    insert:     vi.fn((_f: ItemFilter) => Promise.resolve()),
    update:     vi.fn((_f: ItemFilter) => Promise.resolve()),
    delete:     vi.fn((_id: string) => Promise.resolve()),
    setEnabled: vi.fn((_id: string, _e: boolean) => Promise.resolve()),
  };
  const engine = {updateFilterRules: vi.fn()};
  vi.stubGlobal('window', {electronAPI: {db: {filters}, engine}});
  return {filters, engine};
}

async function load(rows?: ItemFilter[]) {
  vi.resetModules();
  const api = stubApi(rows);
  const {useFilterStore} = await import('@/state/filterStore');
  return {api, store: useFilterStore, get: () => useFilterStore.getState()};
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.unstubAllGlobals();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('filterStore — typed rules', () => {
  it('load() keeps the rows\' typed rules as is', async () => {
    const {get, store} = await load();
    await store.getState().load();
    expect(get().filters).toEqual(ROWS);
    expect(get().isLoaded).toBe(true);
  });

  it('writes send typed rules (arrays), never JSON strings', async () => {
    const {api, get, store} = await load();
    await store.getState().load();
    store.getState().createFilter('C');
    store.getState().addRule('b', RULE);
    store.getState().renameFilter('a', 'A2');
    store.getState().removeRule('a', 'r1');
    const sent = [...api.filters.insert.mock.calls, ...api.filters.update.mock.calls].map(c => c[0]);
    expect(sent.length).toBe(4);
    for (const f of sent) expect(Array.isArray(f.rules)).toBe(true);
    expect(api.filters.update.mock.calls.find(c => c[0].id === 'b')![0].rules).toEqual([RULE]);
    expect(get().filters.find(f => f.id === 'b')!.rules).toEqual([RULE]);
  });

  it('never calls an engine.updateFilterRules, whatever the action', async () => {
    const {api, store} = await load();
    await store.getState().load();
    const s = store.getState();
    s.enableFilter('b');
    s.disableFilter('b');
    s.addRule('a', {...RULE, id: 'r2'});
    s.updateRule('a', 'r2', {action: 'show'});
    s.reorderRules('a', ['r2', 'r1']);
    s.removeRule('a', 'r2');
    s.deleteFilter('b');
    expect(api.engine.updateFilterRules).not.toHaveBeenCalled();
  });

  it('works when the preload exposes no engine.updateFilterRules at all', async () => {
    vi.resetModules();
    const filters = stubApi().filters;
    vi.stubGlobal('window', {electronAPI: {db: {filters}, engine: {}}});
    const {useFilterStore} = await import('@/state/filterStore');
    await useFilterStore.getState().load();
    expect(() => useFilterStore.getState().enableFilter('b')).not.toThrow();
    expect(() => useFilterStore.getState().deleteFilter('a')).not.toThrow();
  });
});

describe('filterStore — rejected write re-syncs', () => {
  it.each<[string, (s: ReturnType<Awaited<ReturnType<typeof load>>['get']>) => void, 'insert' | 'update' | 'delete' | 'setEnabled']>([
    ['createFilter', s => s.createFilter('Z'),           'insert'],
    ['addRule',      s => s.addRule('a', {...RULE, id: 'n'}), 'update'],
    ['deleteFilter', s => s.deleteFilter('a'),           'delete'],
    ['enableFilter', s => s.enableFilter('b'),           'setEnabled'],
  ])('%s: a rejected write reloads via getAll and logs', async (_n, act, method) => {
    const {api, get, store} = await load();
    await store.getState().load();
    expect(api.filters.getAll).toHaveBeenCalledTimes(1);
    (api.filters[method] as unknown as {mockImplementation(f: () => Promise<void>): void}).mockImplementation(() => Promise.reject(new Error('write refused')));
    act(get());
    await vi.waitFor(() => expect(api.filters.getAll).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(get().filters).toEqual(ROWS));
    expect(errorSpy).toHaveBeenCalled();
  });
});
