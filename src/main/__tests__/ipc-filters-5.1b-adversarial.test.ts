/** 5.1b adversarial: db:filters:* handlers - malformed updates, callback failures, double-enabled rows. */
import {describe, it, expect, beforeEach, vi, type Mock} from 'vitest';
import {initDb, getDb, filtersGetAll} from '@/main/db';
import {SqliteSessionStore} from '@/main/db/session-store';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import {registerDbHandlers} from '@/main/ipc/db';

const h = vi.hoisted(() => ({handle: new Map<string, (...args: unknown[]) => unknown>()}));
vi.mock('electron', () => ({ipcMain: {on: vi.fn(), handle: (c: string, fn: (...a: unknown[]) => unknown) => { h.handle.set(c, fn); }}}));

const RULES = [{id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['wealth']}];
const filter = (over: object = {}) => ({id: 'f1', name: 'F', enabled: true, rules: RULES, ...over});
const call = async (channel: string, ...args: unknown[]) => h.handle.get(channel)!({}, ...args);

let changed: Mock<() => void>;
let broadcast: Mock<(c: string) => void>;

beforeEach(() => {
  h.handle.clear();
  const conn = openNodeSqlite();
  initDb(conn, {backup: () => { throw new Error('no backup'); }});
  changed = vi.fn<() => void>();
  broadcast = vi.fn<(c: string) => void>();
  registerDbHandlers({
    broadcast:    broadcast as never,
    sessions:     new SqliteSessionStore(conn),
    tracking:     {isTracking: () => false, deleteSession: () => undefined},
    wealthSeries: {series: () => [], latestBreakdown: () => null, forget: () => undefined, invalidate: () => undefined},
    onFiltersChanged: changed,
    serperKey:    {get: async () => null},
  });
});

describe('filter write handlers', () => {
  it('a malformed UPDATE of an existing filter rejects, keeps the stored row, and tells nobody', async () => {
    await call('db:filters:insert', filter());
    changed.mockClear(); broadcast.mockClear();
    await expect((async () => call('db:filters:update', filter({name: 'X', rules: [null]})))()).rejects.toThrow();
    expect(filtersGetAll()).toEqual([filter()]);
    expect(changed).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith('wealth:changed');
  });

  it('a payload that is not an object at all rejects without storing', async () => {
    for (const bad of [null, undefined, 5, 'x']) {
      await expect((async () => call('db:filters:insert', bad))()).rejects.toThrow();
    }
    expect(filtersGetAll()).toEqual([]);
  });

  it('the wealth broadcast precedes the engine callback, both after the write', async () => {
    const order: string[] = [];
    broadcast.mockImplementation(c => { if (c === 'wealth:changed') order.push(`wealth:${filtersGetAll().length}`); });
    changed.mockImplementation(() => { order.push(`engine:${filtersGetAll().length}`); });
    await call('db:filters:insert', filter());
    expect(order).toEqual(['wealth:1', 'engine:1']);
  });

  it('the callback throwing (a corrupt sibling row) rejects the invoke but the write has landed', async () => {
    getDb().prepare('INSERT INTO item_filters (id, name, enabled, rules) VALUES (?, ?, ?, ?)').run('bad', 'bad', 0, 'junk');
    changed.mockImplementation(() => { filtersGetAll(); });
    await expect((async () => call('db:filters:set-enabled', 'bad', false))()).rejects.toThrow(/unreadable rules/);
    const raw = getDb().prepare('SELECT id FROM item_filters').all() as {id: string}[];
    expect(raw.map(r => r.id)).toContain('bad');
  });

  it('delete / set-enabled of unknown ids resolve and still re-apply (idempotent)', async () => {
    await call('db:filters:insert', filter());
    changed.mockClear();
    await call('db:filters:delete', 'ghost');
    await call('db:filters:set-enabled', 'ghost', true);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(filtersGetAll().every(f => !f.enabled)).toBe(true);
  });

  it('inserting a second enabled filter disables the first (one enabled row), as the callback sees', async () => {
    await call('db:filters:insert', filter({id: 'a'}));
    let active: string | undefined;
    changed.mockImplementation(() => { active = filtersGetAll().find(f => f.enabled)?.id; });
    await call('db:filters:insert', filter({id: 'b'}));
    expect(filtersGetAll().filter(f => f.enabled).map(f => f.id)).toEqual(['b']);
    expect(active).toBe('b');
  });

  it('payload objects with extra properties (renderer-side junk) store only the known fields', async () => {
    await call('db:filters:insert', {...filter(), junk: 'x', rules: [{...RULES[0], junk: 1}]});
    expect(filtersGetAll()).toEqual([filter()]);
  });
});
