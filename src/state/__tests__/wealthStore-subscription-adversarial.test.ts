/**
 * 4.2b adversarial: wealthStore refreshes itself on `wealth_recorded`, on any
 * tab (the store subscribes in load(), no Dashboard involved) — exactly once
 * per recording, and exactly one extra refresh when a recording lands while
 * the first load is still in flight.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEnvelope, WireEngineEvent} from '@/shared/contracts/engine';
import type {DbWealthDatapoint} from '@/shared/contracts/db';

const row = (id: number, value: number): DbWealthDatapoint => ({id, timestamp: id, value, breakdown: '{}'});
const recorded: WireEngineEvent = {type: 'wealth_recorded', timestamp: 1, point: {id: 1, ts: 1, value: 0}};
const other:    WireEngineEvent[] = [
  {type: 'init_started'},
  {type: 'drop', itemId: 1, change: 1, timestamp: 1},
  {type: 'new_item', itemId: 1, timestamp: 1},
  {type: 'session_saved', sessionId: 's'},
];
const env = (seq: number, event: WireEngineEvent): EngineEnvelope => ({seq, event});

function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

async function load() {
  vi.resetModules();
  const listeners: Array<(e: EngineEnvelope) => void> = [];
  let rows: DbWealthDatapoint[] = [row(1, 10)];
  const getRange  = vi.fn(async (_from: number, _to: number) => rows);
  const getLatest = vi.fn(async (_n: number) => rows.slice(-1));
  const getAll    = vi.fn(async () => ({} as Record<string, string>));
  const onEvent   = vi.fn((cb: (e: EngineEnvelope) => void) => { listeners.push(cb); return () => undefined; });
  vi.stubGlobal('window', {electronAPI: {
    engine:   {onEvent},
    settings: {getAll, set: vi.fn(async () => undefined)},
    db:       {wealth: {getRange, getLatest, delete: vi.fn(async () => undefined)}},
  }});
  const {useWealthStore} = await import('@/state/wealthStore');
  return {
    s: () => useWealthStore.getState(), getRange, getLatest, getAll, onEvent,
    setRows: (r: DbWealthDatapoint[]) => { rows = r; },
    push: (e: WireEngineEvent, seq = 1) => { for (const l of listeners) l(env(seq, e)); },
  };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => { vi.unstubAllGlobals(); });

describe('wealthStore subscription', () => {
  it('after load, each wealth_recorded refetches exactly once and the store shows the new row', async () => {
    const t = await load();
    await t.s().load();
    expect(t.getRange).toHaveBeenCalledTimes(1);
    t.setRows([row(1, 10), row(2, 25)]);
    t.push(recorded);
    await flush();
    expect(t.getRange).toHaveBeenCalledTimes(2);
    expect(t.getLatest).toHaveBeenCalledTimes(2);
    expect(t.s().datapoints.map(p => p.id)).toEqual([1, 2]);
    t.push(recorded);
    await flush();
    expect(t.getRange).toHaveBeenCalledTimes(3);
  });

  it('no other engine event refetches anything', async () => {
    const t = await load();
    await t.s().load();
    for (const e of other) t.push(e);
    await flush();
    expect(t.getRange).toHaveBeenCalledTimes(1);
  });

  it('load() twice (StrictMode) subscribes once: one recording, one refetch', async () => {
    const t = await load();
    await t.s().load();
    await t.s().load();
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    const before = t.getRange.mock.calls.length;
    t.push(recorded);
    await flush();
    expect(t.getRange.mock.calls.length).toBe(before + 1);
  });

  it('a recording DURING the first load: nothing at once, exactly one extra refetch after it', async () => {
    const t = await load();
    const settings = deferred<Record<string, string>>();
    t.getAll.mockReturnValueOnce(settings.promise);
    const p = t.s().load();
    expect(t.onEvent).toHaveBeenCalledTimes(1);   // subscribed before the first await
    t.push(recorded);
    t.push(recorded);                              // several recordings still cost one refetch
    await flush();
    expect(t.getRange).not.toHaveBeenCalled();
    expect(t.s().isLoaded).toBe(false);
    t.setRows([row(1, 10), row(2, 99)]);
    settings.resolve({});
    await p;
    expect(t.getRange).toHaveBeenCalledTimes(2);   // the load's own + one refresh
    expect(t.s().datapoints.map(x => x.id)).toEqual([1, 2]);
    // the flag is consumed: a later recording is an ordinary single refresh
    t.push(recorded);
    await flush();
    expect(t.getRange).toHaveBeenCalledTimes(3);
  });

  it('no recording during load: no extra refetch', async () => {
    const t = await load();
    await t.s().load();
    expect(t.getRange).toHaveBeenCalledTimes(1);
    expect(t.getLatest).toHaveBeenCalledTimes(1);
  });

  it('refresh follows the range the user picked, not the default', async () => {
    const t = await load();
    await t.s().load();
    await t.s().setRange('1d');
    t.getRange.mockClear();
    t.push(recorded);
    await flush();
    expect(t.getRange).toHaveBeenCalledTimes(1);
    const [from, to] = t.getRange.mock.calls[0];
    expect(to - from).toBe(24 * 60 * 60 * 1000);
  });

  it('a recording that arrives while load() fails is not lost: the retry refetches once more', async () => {
    const t = await load();
    t.getRange.mockRejectedValueOnce(new Error('db busy'));
    const first = t.s().load();
    t.push(recorded);
    await expect(first).rejects.toThrow('db busy');
    expect(t.s().isLoaded).toBe(false);
    t.getRange.mockClear();
    await t.s().load();
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.getRange).toHaveBeenCalledTimes(2);
    expect(t.s().isLoaded).toBe(true);
  });
});
