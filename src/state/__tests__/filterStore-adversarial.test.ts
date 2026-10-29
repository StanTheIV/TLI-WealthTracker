/** 5.1b adversarial: filterStore against an in-order fake main - rejections, re-sync failures, writes after a failed load. */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {FilterRule, ItemFilter} from '@/shared/item-filter';

const RULE = (id: string): FilterRule => ({id, action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session']});

/** Main processes calls in arrival order; each result resolves on a later microtask. */
function fakeMain(initial: ItemFilter[], opts: {rejectWhen?: (call: string, arg: unknown) => boolean; getAllFails?: () => boolean} = {}) {
  let db = structuredClone(initial);
  const log: string[] = [];
  const settle = <T,>(fn: () => T): Promise<T> => {
    let out: T | undefined; let err: unknown; let failed = false;
    try { out = fn(); } catch (e) { err = e; failed = true; }
    return new Promise<T>((res, rej) => queueMicrotask(() => (failed ? rej(err) : res(out as T))));
  };
  const guard = (call: string, arg: unknown) => { log.push(call); if (opts.rejectWhen?.(call, arg)) throw new Error(`${call} refused`); };
  const filters = {
    getAll:     vi.fn(() => settle(() => { log.push('getAll'); if (opts.getAllFails?.()) throw new Error('corrupt'); return structuredClone(db); })),
    insert:     vi.fn((f: ItemFilter) => settle(() => { guard('insert', f); db.push(structuredClone(f)); })),
    update:     vi.fn((f: ItemFilter) => settle(() => { guard('update', f); db = db.map(x => x.id === f.id ? structuredClone(f) : x); })),
    delete:     vi.fn((id: string) => settle(() => { guard('delete', id); db = db.filter(x => x.id !== id); })),
    setEnabled: vi.fn((id: string, e: boolean) => settle(() => { guard('setEnabled', id); db = db.map(x => ({...x, enabled: e ? x.id === id : x.enabled && x.id !== id})); })),
  };
  return {filters, log, db: () => db};
}

async function setup(main: ReturnType<typeof fakeMain>) {
  vi.resetModules();
  vi.stubGlobal('window', {electronAPI: {db: {filters: main.filters}}});
  const {useFilterStore} = await import('@/state/filterStore');
  return useFilterStore;
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.unstubAllGlobals();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errorSpy.mockRestore());

const BASE: ItemFilter[] = [
  {id: 'a', name: 'A', enabled: true, rules: []},
  {id: 'b', name: 'B', enabled: false, rules: []},
];

describe('rapid successive writes with a rejection in the middle', () => {
  it('addRule r1 (ok), r2 (refused), r3 (ok): after settling the store equals what main stored', async () => {
    const main = fakeMain(BASE, {rejectWhen: (c, a) => c === 'update' && (a as ItemFilter).rules.length === 2});
    const store = await setup(main);
    await store.getState().load();
    store.getState().addRule('a', RULE('r1'));
    store.getState().addRule('a', RULE('r2'));
    store.getState().addRule('a', RULE('r3'));
    await flush();
    expect(store.getState().filters).toEqual(main.db());
    expect(errorSpy).toHaveBeenCalled();
  });

  it('enable b (refused) then enable a (ok): store equals main', async () => {
    const main = fakeMain(BASE, {rejectWhen: (c, a) => c === 'setEnabled' && a === 'b'});
    const store = await setup(main);
    await store.getState().load();
    store.getState().enableFilter('b');
    store.getState().enableFilter('a');
    await flush();
    expect(store.getState().filters).toEqual(main.db());
  });

  it('create (refused) then delete of the never-stored filter: both settle, store equals main', async () => {
    const main = fakeMain(BASE, {rejectWhen: c => c === 'insert'});
    const store = await setup(main);
    await store.getState().load();
    store.getState().createFilter('Z');
    const id = store.getState().filters.find(f => f.name === 'Z')!.id;
    store.getState().deleteFilter(id);
    await flush();
    expect(store.getState().filters).toEqual(main.db());
  });

  it('50 interleaved writes with every 7th refused converge to main\'s state', async () => {
    let n = 0;
    const main = fakeMain(BASE, {rejectWhen: () => ++n % 7 === 0});
    const store = await setup(main);
    await store.getState().load();
    for (let i = 0; i < 50; i++) {
      const s = store.getState();
      if (i % 5 === 0) s.createFilter(`F${i}`);
      else if (i % 5 === 1) s.addRule('a', RULE(`r${i}`));
      else if (i % 5 === 2) s.enableFilter(i % 2 ? 'a' : 'b');
      else if (i % 5 === 3) s.renameFilter('b', `B${i}`);
      else s.removeRule('a', `r${i - 3}`);
    }
    await flush();
    await store.getState().load();
    expect(store.getState().filters).toEqual(main.db());
  });
});

describe('load() failures', () => {
  it('a rejected write whose re-sync load() ALSO rejects: both logged, no unhandled rejection, optimistic state kept', async () => {
    let fail = false;
    const main = fakeMain(BASE, {rejectWhen: c => c === 'update', getAllFails: () => fail});
    const store = await setup(main);
    await store.getState().load();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    fail = true;
    store.getState().addRule('a', RULE('r1'));
    await flush();
    await new Promise(r => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(expect.arrayContaining(['[filters] write failed:', '[filters] re-sync failed:']));
    expect(store.getState().filters.find(f => f.id === 'a')!.rules).toHaveLength(1);
  });

  it('writes after a failed initial load: unknown ids are no-ops (nothing sent), create still goes through, a later load() recovers', async () => {
    let fail = true;
    const main = fakeMain(BASE, {getAllFails: () => fail});
    const store = await setup(main);
    await expect(store.getState().load()).rejects.toThrow('corrupt');
    expect(store.getState().isLoaded).toBe(false);

    store.getState().renameFilter('a', 'X');
    store.getState().addRule('a', RULE('r1'));
    store.getState().enableFilter('a');          // sends setEnabled even for an unknown id (main decides)
    store.getState().createFilter('New');
    await flush();
    expect(main.filters.update).not.toHaveBeenCalled();
    expect(main.filters.insert).toHaveBeenCalledTimes(1);

    fail = false;
    await store.getState().load();
    expect(store.getState().isLoaded).toBe(true);
    expect(store.getState().filters).toEqual(main.db());
  });

  it('delete of a filter then a rule edit on it: the edit is a no-op and sends nothing', async () => {
    const main = fakeMain(BASE);
    const store = await setup(main);
    await store.getState().load();
    store.getState().deleteFilter('a');
    store.getState().addRule('a', RULE('late'));
    await flush();
    expect(main.filters.update).not.toHaveBeenCalled();
    expect(store.getState().filters).toEqual(main.db());
  });
});
