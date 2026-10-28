/**
 * 4.2b renderer side: engineStore `init()` subscribes first, buffers envelopes
 * until `engine.getState()` resolves, applies the snapshot, then applies the
 * buffered and later envelopes with `seq > snapshot.seq` only.
 * window.electronAPI is a stub; the module is re-imported per test because the
 * store keeps a module-level "initialized" flag.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEnvelope as Envelope, WireEngineEvent, EngineSnapshot as Snapshot} from '@/shared/contracts/engine';

const T = 1_000;
const drop = (change: number, itemId = 1): WireEngineEvent => ({type: 'drop', itemId, change, timestamp: T});
const zone = (to: string): WireEngineEvent => ({type: 'zone_change', from: 'x', to, entering: 'town', timestamp: T});
const env  = (seq: number, event: WireEngineEvent): Envelope => ({seq, event});
const BASE: WireEngineEvent[] = [
  {type: 'init_started'},
  {type: 'init_complete', itemCount: 0},
  {type: 'tracker_started', tracker: {kind: 'session', drops: {}, elapsed: 0, startedAt: T, active: true}, timestamp: T,
    sessionMeta: {sessionId: 's', name: 'n', continued: false, mapTime: 0, mapCount: 0}},
];

function deferred<V>() {
  let resolve!: (v: V) => void;
  const promise = new Promise<V>(r => { resolve = r; });
  return {promise, resolve};
}

async function load() {
  vi.resetModules();
  const snapshot = deferred<Snapshot>();
  const listeners: Array<(e: Envelope) => void> = [];
  const order: string[] = [];
  const getState = vi.fn(() => { order.push('getState'); return snapshot.promise; });
  const onEvent  = vi.fn((cb: (e: Envelope) => void) => { order.push('onEvent'); listeners.push(cb); return () => undefined; });
  vi.stubGlobal('window', {electronAPI: {engine: {getState, onEvent, dismissMaterial: vi.fn()}}});
  const {useEngineStore} = await import('@/state/engineStore');
  const {useItemsStore}  = await import('@/state/itemsStore');
  const s = () => useEngineStore.getState();
  const init = () => s().init();
  const lastSeq = () => s().lastSeq;
  const push = (...e: Envelope[]) => { for (const x of e) for (const l of listeners) l(x); };
  return {s, init, lastSeq, push, snapshot, getState, onEvent, order, items: useItemsStore};
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('engineStore.init', () => {
  it('subscribes first, then asks for the state — both exactly once, before anything resolves', async () => {
    const t = await load();
    const p = t.init();
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.getState).toHaveBeenCalledTimes(1);
    expect(t.order).toEqual(['onEvent', 'getState']);
    t.snapshot.resolve({seq: 0, events: []});
    await p;
  });

  it('envelopes arriving before getState resolves are buffered, not applied', async () => {
    const t = await load();
    const p = t.init();
    t.push(env(4, zone('early')), env(5, drop(7)));
    expect(t.s().currentZone).toBeNull();
    expect(t.s().drops).toEqual({});
    expect(t.s().feed).toEqual([]);
    t.snapshot.resolve({seq: 0, events: BASE});
    await p;
    expect(t.s().currentZone).toBe('early');
    expect(t.s().drops).toEqual({1: 7});
  });

  it('after the snapshot: seq <= snapshot.seq dropped (equal included), later ones applied in order', async () => {
    const t = await load();
    const p = t.init();
    t.push(
      env(2, drop(1)),          // older than the snapshot
      env(3, drop(10)),         // equal to snapshot.seq: already in it
      env(4, zone('four')),     // newer: applied
      env(5, zone('five')),     // newer: applied after four
      env(6, drop(1000)),
    );
    t.snapshot.resolve({seq: 3, events: BASE});
    await p;
    expect(t.s().drops).toEqual({1: 1000});
    expect(t.s().currentZone).toBe('five');
    expect(t.lastSeq()).toBe(6);
    // the snapshot's own events are not feed history; the buffered ones are
    expect(t.s().feed.map(f => f.event.type)).toEqual(['zone_change', 'zone_change', 'drop']);
  });

  it('a snapshot with no buffered envelopes just applies it', async () => {
    const t = await load();
    const p = t.init();
    t.snapshot.resolve({seq: 9, events: BASE});
    await p;
    expect(t.lastSeq()).toBe(9);
    expect(t.s().phase).toBe('tracking');
    expect(t.s().activeSessionId).toBe('s');
    expect(t.s().feed).toEqual([]);
  });

  it('live envelopes after init: applied in order; stale and duplicate seq ignored', async () => {
    const t = await load();
    const p = t.init();
    t.snapshot.resolve({seq: 10, events: BASE});
    await p;
    t.push(env(11, drop(1)));
    t.push(env(12, drop(10)));
    t.push(env(12, drop(10)));   // duplicate delivery
    t.push(env(9, drop(100)));   // stale
    t.push(env(13, drop(1000)));
    expect(t.s().drops).toEqual({1: 1011});
    expect(t.lastSeq()).toBe(13);
  });

  it('applying the snapshot replaces whatever the store held', async () => {
    const t = await load();
    t.s().handleEvent(zone('stale'));
    t.s().handleEvent(drop(99));
    const p = t.init();
    t.snapshot.resolve({seq: 1, events: BASE});
    await p;
    expect(t.s().currentZone).toBeNull();
    expect(t.s().drops).toEqual({});
  });

  it('init twice (StrictMode) or concurrently: one subscription, one getState, one snapshot', async () => {
    const t = await load();
    const a = t.init();
    const b = t.init();
    t.snapshot.resolve({seq: 2, events: BASE});
    await Promise.all([a, b]);
    await t.init();
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.getState).toHaveBeenCalledTimes(1);
    expect(t.lastSeq()).toBe(2);
    t.push(env(3, drop(1)));
    expect(t.s().drops).toEqual({1: 1}); // applied once, not once per init
  });

  it('the returned promise settles only after the snapshot is applied', async () => {
    const t = await load();
    let done = false;
    const p = t.init().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    t.snapshot.resolve({seq: 1, events: BASE});
    await p;
    expect(done).toBe(true);
    expect(t.s().phase).toBe('tracking');
  });
});

describe('new_item no longer writes the items store', () => {
  it('handleEvent(new_item) leaves itemsStore untouched (the placeholder arrives via items:changed)', async () => {
    const t = await load();
    t.s().handleEvent({type: 'new_item', itemId: 123, timestamp: T});
    expect(t.items.getState().items).toEqual({});
    expect(t.s().feed.map(f => f.event.type)).toEqual(['new_item']); // still a feed entry
  });
});
