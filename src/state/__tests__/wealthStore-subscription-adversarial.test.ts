/**
 * wealthStore keeps itself current on any tab (it subscribes in load(), no
 * Dashboard involved): each `wealth_recorded` appends exactly one point and
 * re-reads only the latest breakdown; each `wealth:changed` is exactly one
 * refresh; a recording while the first load is in flight is not lost.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {WireEngineEvent} from '@/shared/contracts/engine';
import type {WealthSeriesPoint} from '@/shared/contracts/wealth';
import {DAY_MS, deferred, flush, pt, wealthHarness} from './wealth-harness';

const NOW = 1_800_000_000_000;
const other: WireEngineEvent[] = [
  {type: 'init_started'},
  {type: 'drop', itemId: 1, change: 1, timestamp: 1},
  {type: 'new_item', itemId: 1, timestamp: 1},
  {type: 'session_saved', sessionId: 's'},
];

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('wealthStore subscription', () => {
  it('after load, each wealth_recorded appends once and re-reads only the breakdown', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - 10)]});
    await t.s().load();
    expect(t.series).toHaveBeenCalledTimes(1);
    t.record(pt(2, NOW - 5));
    await flush();
    expect(t.series).toHaveBeenCalledTimes(1);
    expect(t.latestBreakdown).toHaveBeenCalledTimes(2);
    expect(t.s().points.map(p => p.id)).toEqual([1, 2]);
    t.record(pt(3, NOW));
    await flush();
    expect(t.latestBreakdown).toHaveBeenCalledTimes(3);
    expect(t.s().points.map(p => p.id)).toEqual([1, 2, 3]);
  });

  it('no other engine event fetches or changes anything', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW)]});
    await t.s().load();
    const before = t.s().points;
    for (const e of other) t.push(e);
    await flush();
    expect(t.series).toHaveBeenCalledTimes(1);
    expect(t.latestBreakdown).toHaveBeenCalledTimes(1);
    expect(t.s().points).toBe(before);
  });

  it('each wealth:changed is exactly one refresh', async () => {
    const t = await wealthHarness();
    await t.s().load();
    t.changed();
    await flush();
    expect(t.series).toHaveBeenCalledTimes(2);
    t.changed();
    await flush();
    expect(t.series).toHaveBeenCalledTimes(3);
  });

  it('load() twice (StrictMode) subscribes once: one recording, one point, one re-read', async () => {
    const t = await wealthHarness();
    await t.s().load();
    await t.s().load();
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.onChanged).toHaveBeenCalledTimes(1);
    const latestBefore = t.latestBreakdown.mock.calls.length;
    const seriesBefore = t.series.mock.calls.length;
    t.record(pt(1, NOW));
    await flush();
    expect(t.s().points.map(p => p.id)).toEqual([1]);
    expect(t.latestBreakdown.mock.calls.length).toBe(latestBefore + 1);
    t.changed();
    await flush();
    expect(t.series.mock.calls.length).toBe(seriesBefore + 1);
  });

  it('load() twice concurrently: the second load lands, the first is stale, one subscription', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW)]});
    const first = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(first.promise);
    const a = t.s().load();
    await flush();
    const b = t.s().load();
    await b;
    first.resolve([]);
    await a;
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.s().points.map(p => p.id)).toEqual([1]);
  });

  it('recordings DURING the first load: subscribed before the first await, none lost, no series refetch', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - 10)]});
    const settings = deferred<Record<string, string>>();
    t.getAll.mockReturnValueOnce(settings.promise);
    const p = t.s().load();
    expect(t.onEvent).toHaveBeenCalledTimes(1);   // subscribed before the first await
    expect(t.onChanged).toHaveBeenCalledTimes(1);
    t.record(pt(2, NOW - 5));
    t.record(pt(3, NOW));
    await flush();
    expect(t.series).not.toHaveBeenCalled();
    expect(t.s().isLoaded).toBe(false);
    settings.resolve({});
    await p;
    await flush();
    expect(t.series).toHaveBeenCalledTimes(1);
    expect(t.s().points.map(x => x.id)).toEqual([1, 2, 3]);
    expect(t.s().latest?.id).toBe(3);
    // a later recording is an ordinary append
    t.record(pt(4, NOW));
    await flush();
    expect(t.series).toHaveBeenCalledTimes(1);
    expect(t.s().points.map(x => x.id)).toEqual([1, 2, 3, 4]);
  });

  it('a recording while the load response is in flight is merged into it', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - 10)]});
    const first = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(first.promise);
    const p = t.s().load();
    await flush();
    t.record(pt(2, NOW));
    t.record(pt(2, NOW));                         // a repeat stays one point
    first.resolve([pt(1, NOW - 10)]);
    await p;
    expect(t.s().points.map(x => x.id)).toEqual([1, 2]);
    expect(t.series).toHaveBeenCalledTimes(1);
  });

  it('no recording during load: one series read, one breakdown read', async () => {
    const t = await wealthHarness();
    await t.s().load();
    expect(t.series).toHaveBeenCalledTimes(1);
    expect(t.latestBreakdown).toHaveBeenCalledTimes(1);
  });

  it('a refresh follows the range the user picked, not the default', async () => {
    const t = await wealthHarness();
    await t.s().load();
    await t.s().setRange('1d');
    t.series.mockClear();
    t.changed();
    await flush();
    expect(t.series).toHaveBeenCalledTimes(1);
    const [from, to] = t.series.mock.calls[0];
    expect(to - from).toBe(DAY_MS);
  });

  it('a recording that arrives while load() fails is not lost: the retry shows it', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - 10)]});
    const failing = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(failing.promise);
    const first = t.s().load();
    await flush();
    t.record(pt(2, NOW));
    failing.reject(new Error('db busy'));
    await expect(first).rejects.toThrow('db busy');
    expect(t.s().isLoaded).toBe(false);
    await t.s().load();
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.series).toHaveBeenCalledTimes(2);
    expect(t.s().isLoaded).toBe(true);
    expect(t.s().points.map(x => x.id)).toEqual([1, 2]);
  });
});
