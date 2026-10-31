/** A fresh wealthStore over a stubbed `window.electronAPI` that behaves like
 *  main: a table of displayed readings, `wealth_recorded` after a stored one,
 *  `wealth:changed` after a delete. Shared by the wealthStore tests. */
import {vi} from 'vitest';
import type {EngineEnvelope, WireEngineEvent} from '@/shared/contracts/engine';
import type {WealthLatestBreakdown, WealthSeriesPoint} from '@/shared/contracts/wealth';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS  = 24 * HOUR_MS;

export const pt = (id: number, ts: number, value = id * 10): WealthSeriesPoint => ({id, ts, value});

export function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

export async function wealthHarness(opts: {rows?: WealthSeriesPoint[]; storedRange?: string} = {}) {
  vi.resetModules();
  const engineListeners:  Array<(e: EngineEnvelope) => void> = [];
  const changedListeners: Array<() => void> = [];
  let rows = [...(opts.rows ?? [])];

  const latestOf = (): WealthLatestBreakdown | null => {
    const last = [...rows].sort((a, b) => a.ts - b.ts).at(-1);
    return last ? {...last, rows: [{id: `item-${last.id}`, qty: 1, unitPrice: last.value, total: last.value}]} : null;
  };
  const changed = () => { for (const l of changedListeners) l(); };

  const series = vi.fn(async (from: number, to: number) =>
    rows.filter(r => r.ts >= from && r.ts <= to).sort((a, b) => a.ts - b.ts));
  const latestBreakdown = vi.fn(async () => latestOf());
  // Main deletes, then announces the change: the store refreshes on that alone.
  const del = vi.fn(async (id: number) => { rows = rows.filter(r => r.id !== id); changed(); });
  const getAll = vi.fn(async () =>
    (opts.storedRange ? {wealthChartRange: opts.storedRange} : {}) as Record<string, string>);
  const setSetting = vi.fn(async () => undefined);
  const onEvent   = vi.fn((cb: (e: EngineEnvelope) => void) => { engineListeners.push(cb); return () => undefined; });
  const onChanged = vi.fn((cb: () => void) => { changedListeners.push(cb); return () => undefined; });

  vi.stubGlobal('window', {electronAPI: {
    engine:   {onEvent},
    settings: {getAll, set: setSetting},
    db:       {wealth: {series, latestBreakdown, delete: del, onChanged}},
  }});
  const {useWealthStore} = await import('@/state/wealthStore');

  const push = (event: WireEngineEvent, seq = 1) => { for (const l of engineListeners) l({seq, event}); };
  return {
    s: () => useWealthStore.getState(),
    series, latestBreakdown, del, getAll, setSetting, onEvent, onChanged,
    rows: () => rows,
    setRows: (r: WealthSeriesPoint[]) => { rows = [...r]; },
    /** Main stores the reading, then announces it. */
    record: (point: WealthSeriesPoint) => {
      rows.push(point);
      push({type: 'wealth_recorded', timestamp: point.ts, point});
    },
    /** The announcement alone, for a reading already in (or kept out of) the table. */
    announce: (point: WealthSeriesPoint) => push({type: 'wealth_recorded', timestamp: point.ts, point}),
    push,
    changed,
  };
}
