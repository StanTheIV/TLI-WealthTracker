/**
 * 5.1b IPC wiring (electron's ipcMain mocked like the other ipc tests):
 * engine:update-filter-rules is gone, engine:start is a `handle`, and every
 * db:filters:* write tells tracking to re-apply the stored active filter.
 */
import {describe, it, expect, beforeEach, vi, type Mock} from 'vitest';
import {initDb, filtersGetAll} from '@/main/db';
import {SqliteSessionStore} from '@/main/db/session-store';
import {openNodeSqlite} from '@/test/sql/node-sqlite';
import {registerEngineHandlers} from '@/main/ipc/engine';
import {registerDbHandlers} from '@/main/ipc/db';
import type {TrackingService} from '@/main/tracking-service';

const h = vi.hoisted(() => ({
  on:     new Map<string, (...args: unknown[]) => unknown>(),
  handle: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on:     (c: string, fn: (...a: unknown[]) => unknown) => { h.on.set(c, fn); },
    handle: (c: string, fn: (...a: unknown[]) => unknown) => { h.handle.set(c, fn); },
  },
}));

const RULES = [{id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['wealth']}];
const filter = (over: object = {}) => ({id: 'f1', name: 'F', enabled: true, rules: RULES, ...over});

beforeEach(() => {
  h.on.clear();
  h.handle.clear();
});

describe('ipc/engine', () => {
  it('registers no engine:update-filter-rules', () => {
    registerEngineHandlers({} as TrackingService);
    expect(h.on.has('engine:update-filter-rules')).toBe(false);
    expect(h.handle.has('engine:update-filter-rules')).toBe(false);
  });

  it('engine:start is a handle (not an on) that returns the start result and rejects on a throw', async () => {
    const start = vi.fn();
    registerEngineHandlers({start} as unknown as TrackingService);
    expect(h.on.has('engine:start')).toBe(false);
    expect(h.handle.has('engine:start')).toBe(true);
    await h.handle.get('engine:start')!({});
    expect(start).toHaveBeenCalledTimes(1);
    start.mockImplementation(() => { throw new Error('start refused'); });
    await expect((async () => h.handle.get('engine:start')!({}))()).rejects.toThrow('start refused');
  });
});

describe('ipc/db — filter writes re-apply the active filter in tracking', () => {
  let changed: Mock<() => void>;
  const call = async (channel: string, ...args: unknown[]) => h.handle.get(channel)!({}, ...args);

  beforeEach(() => {
    const conn = openNodeSqlite();
    initDb(conn, {backup: () => { throw new Error('no backup'); }});
    changed = vi.fn<() => void>();
    registerDbHandlers({
      broadcast:    () => undefined,
      sessions:     new SqliteSessionStore(conn),
      tracking:     {isTracking: () => false, deleteSession: () => undefined},
      wealthSeries: {series: () => [], latestBreakdown: () => null, forget: () => undefined, invalidate: () => undefined},
      onFiltersChanged: changed,
      serperKey:    {get: async () => null},
    });
  });

  it('insert, update, set-enabled and delete each call it once, after the write', async () => {
    for (const [channel, args] of [
      ['db:filters:insert',      [filter()]],
      ['db:filters:update',      [filter({name: 'G'})]],
      ['db:filters:set-enabled', ['f1', false]],
      ['db:filters:delete',      ['f1']],
    ] as const) {
      const before = changed.mock.calls.length;
      await call(channel, ...args);
      expect(changed.mock.calls.length, channel).toBe(before + 1);
    }
  });

  it('the callback sees the stored state (the write has landed)', async () => {
    let seen: unknown;
    changed.mockImplementation(() => { seen = filtersGetAll(); });
    await call('db:filters:insert', filter());
    expect(seen).toEqual([filter()]);
  });

  it('a rejected malformed insert does not call it and stores nothing', async () => {
    await expect((async () => call('db:filters:insert', filter({rules: 'x'})))()).rejects.toThrow();
    expect(changed).not.toHaveBeenCalled();
    expect(filtersGetAll()).toEqual([]);
  });

  it('reads do not call it', async () => {
    await call('db:filters:get-all');
    expect(changed).not.toHaveBeenCalled();
  });
});
