/**
 * 4.5c: the Dashboard shows main's valued series. A recording APPENDS its
 * point (ts order, range trim, de-dup by id) and re-reads only the latest
 * breakdown; `wealth:changed` refreshes; a response never lands over a newer
 * request's; an append is never lost to a response that predates it.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {WealthLatestBreakdown, WealthSeriesPoint} from '@/shared/contracts/wealth';
import {DAY_MS, HOUR_MS, deferred, flush, pt, wealthHarness} from './wealth-harness';

const NOW = 1_800_000_000_000;
let now = NOW;

beforeEach(() => {
  vi.unstubAllGlobals();
  now = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); });

const ids = (points: WealthSeriesPoint[]) => points.map(p => p.id);

describe('load', () => {
  it('fetches the persisted range and the latest breakdown, as main values them', async () => {
    const t = await wealthHarness({
      storedRange: '1d',
      rows: [pt(1, NOW - 2 * DAY_MS), pt(2, NOW - 5 * HOUR_MS, 123.45), pt(3, NOW - HOUR_MS, 99)],
    });
    await t.s().load();
    expect(t.series).toHaveBeenCalledWith(NOW - DAY_MS, NOW);
    expect(t.s().range).toBe('1d');
    expect(t.s().points).toEqual([pt(2, NOW - 5 * HOUR_MS, 123.45), pt(3, NOW - HOUR_MS, 99)]);
    expect(t.s().latest).toMatchObject({id: 3, ts: NOW - HOUR_MS, value: 99});
    expect(t.s().isLoaded).toBe(true);
  });

  it("'all' asks from 0", async () => {
    const t = await wealthHarness({storedRange: 'all'});
    await t.s().load();
    expect(t.series).toHaveBeenCalledWith(0, NOW);
  });

  it('an unknown stored range keeps the default 1m', async () => {
    const t = await wealthHarness({storedRange: '2w'});
    await t.s().load();
    expect(t.s().range).toBe('1m');
    expect(t.series).toHaveBeenCalledWith(NOW - 30 * DAY_MS, NOW);
  });

  it('with no readings: empty series, latest null', async () => {
    const t = await wealthHarness();
    await t.s().load();
    expect(t.s().points).toEqual([]);
    expect(t.s().latest).toBeNull();
    expect(t.s().isLoaded).toBe(true);
  });

  it('a range picked while the stored one is read wins', async () => {
    const t = await wealthHarness({storedRange: '7d', rows: [pt(1, NOW - 2 * DAY_MS), pt(2, NOW - HOUR_MS)]});
    const settings = deferred<Record<string, string>>();
    t.getAll.mockReturnValueOnce(settings.promise);
    const loading = t.s().load();
    await t.s().setRange('1d');
    settings.resolve({wealthChartRange: '7d'});
    await loading;
    expect(t.s().range).toBe('1d');
    expect(ids(t.s().points)).toEqual([2]);
  });
});

describe('wealth_recorded appends', () => {
  it('appends the event point without re-reading the series, and re-reads the latest breakdown', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS)]});
    await t.s().load();
    t.record(pt(2, NOW, 777));
    await flush();
    expect(t.series).toHaveBeenCalledTimes(1);
    expect(t.latestBreakdown).toHaveBeenCalledTimes(2);
    expect(t.s().points).toEqual([pt(1, NOW - HOUR_MS), pt(2, NOW, 777)]);
    expect(t.s().latest).toMatchObject({id: 2, value: 777});
  });

  it('shows the value main put on the event, not a re-derived one', async () => {
    const t = await wealthHarness();
    await t.s().load();
    t.announce(pt(5, NOW, 1234.5));
    await flush();
    expect(t.s().points).toEqual([pt(5, NOW, 1234.5)]);
  });

  it('keeps timestamp order for an out-of-order reading', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - 3 * HOUR_MS), pt(3, NOW - HOUR_MS)]});
    await t.s().load();
    t.record(pt(2, NOW - 2 * HOUR_MS));
    t.record(pt(4, NOW - HOUR_MS));   // same ts as #3: after it
    await flush();
    expect(ids(t.s().points)).toEqual([1, 2, 3, 4]);
  });

  it('de-dups by id: a repeated reading replaces, never doubles', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS)]});
    await t.s().load();
    t.announce(pt(1, NOW - HOUR_MS, 55));
    t.announce(pt(1, NOW - HOUR_MS, 66));
    await flush();
    expect(t.s().points).toEqual([pt(1, NOW - HOUR_MS, 66)]);
  });

  it("trims the readings that slid out of the range's window", async () => {
    const t = await wealthHarness({storedRange: '1d', rows: [pt(1, NOW - 23 * HOUR_MS), pt(2, NOW - HOUR_MS)]});
    await t.s().load();
    now = NOW + 2 * HOUR_MS;   // #1 is now 25 h old
    t.record(pt(3, now));
    await flush();
    expect(ids(t.s().points)).toEqual([2, 3]);
  });

  it('a reading older than the window is not added', async () => {
    const t = await wealthHarness({storedRange: '1d', rows: [pt(2, NOW - HOUR_MS)]});
    await t.s().load();
    t.announce(pt(1, NOW - 2 * DAY_MS));
    await flush();
    expect(ids(t.s().points)).toEqual([2]);
  });

  it("'all' never trims", async () => {
    const t = await wealthHarness({storedRange: 'all', rows: [pt(1, 5)]});
    await t.s().load();
    now = NOW + 400 * DAY_MS;
    t.record(pt(2, now));
    await flush();
    expect(ids(t.s().points)).toEqual([1, 2]);
  });

  it('a failing breakdown re-read keeps the appended point and is logged, not thrown', async () => {
    const t = await wealthHarness();
    await t.s().load();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    t.latestBreakdown.mockRejectedValueOnce(new Error('db busy'));
    t.record(pt(1, NOW));
    await flush();
    expect(ids(t.s().points)).toEqual([1]);
    expect(error).toHaveBeenCalledWith('[wealth] latest refresh failed:', expect.any(Error));
  });
});

describe('wealth:changed refreshes', () => {
  it('re-reads series and breakdown once and shows the new values', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS, 10), pt(2, NOW, 20)]});
    await t.s().load();
    t.setRows([pt(1, NOW - HOUR_MS, 8.5), pt(2, NOW, 17)]);   // e.g. tax switched on
    t.changed();
    await flush();
    expect(t.series).toHaveBeenCalledTimes(2);
    expect(t.latestBreakdown).toHaveBeenCalledTimes(2);
    expect(t.s().points).toEqual([pt(1, NOW - HOUR_MS, 8.5), pt(2, NOW, 17)]);
    expect(t.s().latest).toMatchObject({id: 2, value: 17});
  });

  it('follows the picked range', async () => {
    const t = await wealthHarness();
    await t.s().load();
    await t.s().setRange('3d');
    t.series.mockClear();
    t.changed();
    await flush();
    expect(t.series).toHaveBeenCalledWith(NOW - 3 * DAY_MS, NOW);
  });

  it('a failing refresh is logged, not an unhandled rejection, and keeps what was shown', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW)]});
    await t.s().load();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    t.series.mockRejectedValueOnce(new Error('db busy'));
    t.changed();
    await flush();
    expect(error).toHaveBeenCalledWith('[wealth] refresh failed:', expect.any(Error));
    expect(ids(t.s().points)).toEqual([1]);
  });
});

describe('delete', () => {
  it("refreshes once, on main's wealth:changed, and the latest moves back", async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS), pt(2, NOW)]});
    await t.s().load();
    await t.s().deletePoint(2);
    await flush();
    expect(t.del).toHaveBeenCalledWith(2);
    expect(t.series).toHaveBeenCalledTimes(2);
    expect(t.latestBreakdown).toHaveBeenCalledTimes(2);
    expect(ids(t.s().points)).toEqual([1]);
    expect(t.s().latest?.id).toBe(1);
  });

  it('does not fetch on its own: without the broadcast nothing is re-read', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW)]});
    await t.s().load();
    t.del.mockImplementationOnce(async () => undefined);
    await t.s().deletePoint(1);
    await flush();
    expect(t.series).toHaveBeenCalledTimes(1);
  });

  it('a refused delete rejects to the caller and re-reads nothing', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW)]});
    await t.s().load();
    t.del.mockRejectedValueOnce(new Error('nope'));
    await expect(t.s().deletePoint(1)).rejects.toThrow('nope');
    expect(t.series).toHaveBeenCalledTimes(1);
  });
});

describe('stale-response guard', () => {
  it('two overlapping refreshes: the older answering last does not win', async () => {
    const t = await wealthHarness();
    await t.s().load();
    const older = deferred<WealthSeriesPoint[]>();
    const newer = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const a = t.s().refresh();
    const b = t.s().refresh();
    newer.resolve([pt(2, NOW, 200)]);
    await b;
    older.resolve([pt(1, NOW, 100)]);
    await a;
    expect(t.s().points).toEqual([pt(2, NOW, 200)]);
  });

  it("setRange: a slow 'all' answering after a quick '1d' does not overwrite it", async () => {
    const t = await wealthHarness();
    await t.s().load();
    const all   = deferred<WealthSeriesPoint[]>();
    const day   = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(all.promise).mockReturnValueOnce(day.promise);
    const a = t.s().setRange('all');
    const d = t.s().setRange('1d');
    day.resolve([pt(9, NOW)]);
    await d;
    all.resolve([pt(1, 5), pt(9, NOW)]);
    await a;
    expect(t.s().range).toBe('1d');
    expect(ids(t.s().points)).toEqual([9]);
  });

  it('a stale latest breakdown does not overwrite the one a later recording read', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS)]});
    await t.s().load();
    const slow = deferred<WealthLatestBreakdown | null>();
    t.latestBreakdown.mockReturnValueOnce(slow.promise);
    const refreshing = t.s().refresh();   // reads the breakdown before #2 exists
    t.record(pt(2, NOW));                 // re-reads it after
    await flush();
    expect(t.s().latest?.id).toBe(2);
    slow.resolve({...pt(1, NOW - HOUR_MS), rows: []});
    await refreshing;
    expect(t.s().latest?.id).toBe(2);
  });

  it('an older request failing after a newer one was issued leaves the newer to land', async () => {
    const t = await wealthHarness();
    await t.s().load();
    const older = deferred<WealthSeriesPoint[]>();
    const newer = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const a = t.s().refresh();
    const b = t.s().refresh();
    t.announce(pt(3, NOW));
    older.reject(new Error('db busy'));
    await expect(a).rejects.toThrow('db busy');
    newer.resolve([pt(2, NOW - HOUR_MS)]);
    await b;
    expect(ids(t.s().points)).toEqual([2, 3]);
  });
});

describe('an append never lost to a response that predates it', () => {
  it('during the first load: the load response without it still shows it', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS)]});
    const first = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(first.promise);
    const loading = t.s().load();
    await flush();                         // the series request is out
    t.record(pt(2, NOW, 50));
    first.resolve([pt(1, NOW - HOUR_MS)]); // main answered before storing #2
    await loading;
    expect(t.s().points).toEqual([pt(1, NOW - HOUR_MS), pt(2, NOW, 50)]);
    expect(t.s().latest?.id).toBe(2);
    expect(t.series).toHaveBeenCalledTimes(1);
  });

  it('during the first load: a response that already has it does not double it', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS)]});
    const first = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(first.promise);
    const loading = t.s().load();
    await flush();
    t.record(pt(2, NOW, 50));
    first.resolve([pt(1, NOW - HOUR_MS), pt(2, NOW, 50)]);
    await loading;
    expect(ids(t.s().points)).toEqual([1, 2]);
  });

  it('during a refresh: the response is authoritative for the readings it has', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS, 10)]});
    await t.s().load();
    const pending = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(pending.promise);
    const refreshing = t.s().refresh();
    t.record(pt(2, NOW, 20));
    pending.resolve([pt(1, NOW - HOUR_MS, 9)]);   // revalued #1, no #2 yet
    await refreshing;
    expect(t.s().points).toEqual([pt(1, NOW - HOUR_MS, 9), pt(2, NOW, 20)]);
  });

  it('after the response landed, the appended list is spent: a later refresh drops a deleted reading', async () => {
    const t = await wealthHarness({rows: [pt(1, NOW - HOUR_MS)]});
    const first = deferred<WealthSeriesPoint[]>();
    t.series.mockReturnValueOnce(first.promise);
    const loading = t.s().load();
    await flush();
    t.record(pt(2, NOW));
    first.resolve([pt(1, NOW - HOUR_MS)]);
    await loading;
    await t.s().deletePoint(2);
    await flush();
    expect(ids(t.s().points)).toEqual([1]);
  });
});
