/**
 * 4.2b adversarial, service + store together: a window that subscribes at one
 * point, asks for the state at a later one and receives the snapshot later
 * still must end exactly where a window that saw every envelope live ends —
 * whatever mix of pre-snapshot, overlapping (seq <= snapshot.seq) and later
 * envelopes it got. The snapshot is the real `TrackingService.getState()`.
 *
 * Plus the service's seq contract across every control, and getState() taken
 * from inside a broadcast callback.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import type {Broadcast} from '@/main/broadcast';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEnvelope, EngineSnapshot, TrackerSnapshot} from '@/shared/contracts/engine';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {engineEnvelopes, type Sent} from '@/test/broadcast';
import {TOWN, MAP, log} from '@/main/engine/__tests__/seasonal-fixtures';
import {createDispatcher} from '@/worker/create-dispatcher';
import {fakeWealthRecorder, fakeWealthSeries} from '@/test/wealth';

const NOW  = new Date('2026-03-01T12:00:00Z').getTime();
const BAG  = 100;
const LOOT = 200;
const FOUND = 300;

function build() {
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: Sent[] = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const broadcastHooks: Array<(channel: string, payload: unknown) => void> = [];
  const broadcast: Broadcast = (channel, payload) => { sent.push({channel, payload}); for (const h of broadcastHooks) h(channel, payload); };
  const service = new TrackingService({
    createEngine:   emit => createProductionEngine(emit),
    store,
    broadcast,
    createWorker:   cb => { onEvent = cb; return {start: vi.fn(), stop: vi.fn()} satisfies LogWorker; },
    settings:       {getAll: () => ({torchlightPath: 'C:/Games/TLI'})},
    filters:        {getAll: () => []},
    items: {
      getAll: () => [], getLocked: () => false, insertIfMissing: () => true,
      recordScrapedPrice: () => ({priceDate: NOW}),
    } as unknown as TrackingDeps['items'],
    wealthRecorder: fakeWealthRecorder(),
    wealthSeries:   fakeWealthSeries(),
    log:            {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
  });
  return {service, sent, broadcastHooks, raw: (r: RawEvent) => onEvent!(r)};
}
type H = ReturnType<typeof build>;

const bagInit = (h: H) => { h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: BAG, quantity: 5}); h.raw({type: 'bag_snapshot_start'}); };
const go      = (h: H, a: string, b: string) => h.raw({type: 'zone_transition', fromScene: a, toScene: b});
const bag     = (h: H, qty: number) => h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: LOOT, quantity: qty});
const dispatcher = createDispatcher();
const line    = (h: H, text: string) => { for (const r of dispatcher.dispatch(text)) h.raw(r); };
const price   = (h: H, id: number) => h.raw({type: 'price_update', itemId: id, price: 3, listings: [3]});
/** A first-seen item picked up in town: once the town buffer settles, a lone `new_item`. */
const pickup  = (h: H, id: number) => h.raw({type: 'bag_update', pageId: 0, slotId: 3, itemId: id, quantity: 1});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The script: each op runs, then the service is at a quiescent boundary. */
function script(h: H): Array<[string, () => void]> {
  let q = 0;
  const adv = (ms: number) => () => { vi.advanceTimersByTime(ms); };
  return [
    ['start',        () => h.service.start()],
    ['init',         () => bagInit(h)],
    ['town pickup',  () => { pickup(h, FOUND); adv(1_500)(); }],
    ['enter map',    () => { adv(2_000)(); go(h, TOWN, MAP); }],
    ['drop',         () => { adv(3_000)(); bag(h, ++q); }],
    ['price',        () => price(h, 2)],
    ['carjack start', () => { adv(1_000)(); line(h, log.s11Start); }],
    ['pause',        () => { adv(4_000)(); h.service.pause(); }],
    ['drop paused',  () => bag(h, ++q)],
    ['resume',       () => { adv(2_000)(); h.service.resume(); }],
    ['carjack end',   () => { adv(5_000)(); line(h, log.s11End); }],
    ['drop',         () => { adv(1_000)(); bag(h, ++q); }],
    ['reset',        () => { adv(1_000)(); h.service.reset(); }],
    ['drop',         () => { adv(1_000)(); bag(h, ++q); }],
    ['to town',      () => { adv(30_000)(); go(h, MAP, TOWN); }],
    ['settle',       () => adv(120_000)()],
    ['stop',         () => h.service.stop()],
    ['start again',  () => h.service.start()],
    ['init again',   () => bagInit(h)],
    ['enter map',    () => { adv(1_000)(); go(h, TOWN, MAP); }],
    ['drop',         () => { adv(1_000)(); bag(h, ++q); }],
  ];
}

interface Boundary { label: string; seqAfter: number; snapshot: EngineSnapshot }
function record() {
  const h = build();
  const boundaries: Boundary[] = [];
  for (const [label, op] of script(h)) {
    op();
    boundaries.push({label, seqAfter: engineEnvelopes(h.sent).at(-1)?.seq ?? 0, snapshot: h.service.getState()});
  }
  return {h, boundaries, envelopes: engineEnvelopes(h.sent)};
}

// -- a fresh engineStore instance per window ---------------------------------

async function freshStore() {
  vi.resetModules();
  const listeners: Array<(e: EngineEnvelope) => void> = [];
  let resolveState!: (s: EngineSnapshot) => void;
  let rejectState!: (e: unknown) => void;
  const statePromise = new Promise<EngineSnapshot>((res, rej) => { resolveState = res; rejectState = rej; });
  const getState = vi.fn(() => statePromise);
  vi.stubGlobal('window', {electronAPI: {engine: {getState, onEvent: (cb: (e: EngineEnvelope) => void) => { listeners.push(cb); return () => undefined; }, dismissMaterial: vi.fn()}}});
  const mod = await import('@/state/engineStore');
  return {
    store: mod.useEngineStore, selectRunStatus: mod.selectRunStatus, getState,
    deliver: (...es: EngineEnvelope[]) => { for (const e of es) for (const l of listeners) l(e); },
    resolveState, rejectState, subscriptions: () => listeners.length,
  };
}

/** The comparable view; a running tracker's `elapsed` is excluded (snapshots are taken at different instants). */
function view(w: Awaited<ReturnType<typeof freshStore>>) {
  const s = w.store.getState();
  const status = w.selectRunStatus(s);
  const strip = (t: TrackerSnapshot | null) => t && (t.active && status === 'running' ? {...t, elapsed: 0} : t);
  return {
    phase: s.phase, status, drops: s.drops, sessionSpent: s.sessionSpent, mapCount: s.mapCount,
    currentZone: s.currentZone, map: strip(s.mapTracker),
    seasonals: [...s.seasonalTrackers].map(([k, v]) => [k, strip(v)] as const).sort((a, b) => a[0].localeCompare(b[0])),
    sessionStatus: s.sessionStatus, sessionElapsed: status === 'running' ? 0 : s.sessionElapsed,
    accumulatedMapTime: s.accumulatedMapTime, activeSessionId: s.activeSessionId, activeSessionName: s.activeSessionName,
    deadlines: [...s.lootWindowDeadlines].sort((a, b) => a[0].localeCompare(b[0])),
    lowStock: s.lowStockWarnings,
  };
}

describe('catch-up: subscribe at a, getState at b, resolve at c (a <= b <= c, over every boundary of a real run)', () => {
  it('ends equal to a window that saw every envelope live', async () => {
    const {boundaries, envelopes} = record();
    expect(envelopes.length).toBeGreaterThan(40);
    expect(envelopes.some(e => e.event.type === 'loot_window_started')).toBe(true); // the carjack window is in play
    // Boundaries whose envelopes no replay holds: a lone feed-only new_item, and a scraped price that broadcasts none.
    const addedAt = (label: string) => {
      const i = boundaries.findIndex(b => b.label === label);
      return envelopes.filter(e => e.seq > boundaries[i - 1].seqAfter && e.seq <= boundaries[i].seqAfter).map(e => e.event.type);
    };
    expect(addedAt('town pickup')).toEqual(['new_item']);
    expect(boundaries.every(b => !b.snapshot.events.some(e => e.type === 'new_item'))).toBe(true);
    expect(addedAt('price')).toEqual([]);

    const ref = await freshStore();
    for (const {event} of envelopes) ref.store.getState().handleEvent(event);
    const expected = view(ref);
    expect(expected.phase).toBe('tracking');

    const n = boundaries.length;
    let combos = 0;
    for (let a = 0; a < n; a++) {
      for (let b = a; b < Math.min(n, a + 6); b++) {
        if (boundaries[b].snapshot.events.length === 0) continue; // idle: nothing to catch up on
        for (let c = b; c < Math.min(n, b + 4); c++) {
          const w = await freshStore();
          const p = w.store.getState().init();
          // envelopes broadcast after the subscription (boundary a) up to the resolve (boundary c) arrive buffered
          const lo = a === 0 ? 0 : boundaries[a - 1].seqAfter;
          const hi = boundaries[c].seqAfter;
          w.deliver(...envelopes.filter(e => e.seq > lo && e.seq <= hi));
          w.resolveState(boundaries[b].snapshot);
          await p;
          // then everything after c, live
          w.deliver(...envelopes.filter(e => e.seq > hi));
          expect(view(w), `a=${boundaries[a].label} b=${boundaries[b].label} c=${boundaries[c].label}`).toEqual(expected);
          combos++;
        }
      }
    }
    expect(combos).toBeGreaterThan(150);
  }, 120_000);

  it('envelopes re-delivered after the run (duplicates, whole history replayed) change nothing', async () => {
    const {boundaries, envelopes} = record();
    const b = boundaries[11];
    const w = await freshStore();
    const p = w.store.getState().init();
    w.resolveState(b.snapshot);
    await p;
    w.deliver(...envelopes.filter(e => e.seq > b.snapshot.seq));
    const once = view(w);
    w.deliver(...envelopes);                       // the whole history again, including the snapshot's own
    expect(view(w)).toEqual(once);
    expect(w.store.getState().lastSeq).toBe(envelopes.at(-1)!.seq);
  });
});

describe('getState() rejecting', () => {
  it('init rejects, the subscription survives, buffered and later envelopes still apply; init is not retried', async () => {
    const {envelopes} = record();
    const w = await freshStore();
    const p = w.store.getState().init();
    const early = envelopes.slice(0, 12);
    w.deliver(...early);
    expect(w.store.getState().phase).toBe('idle');
    w.rejectState(new Error('ipc gone'));
    await expect(p).rejects.toThrow('ipc gone');
    expect(w.store.getState().lastSeq).toBe(early.at(-1)!.seq);
    w.deliver(...envelopes.slice(12));
    expect(w.store.getState().lastSeq).toBe(envelopes.at(-1)!.seq);
    await expect(w.store.getState().init()).rejects.toThrow('ipc gone'); // same settled promise
    expect(w.getState).toHaveBeenCalledTimes(1);
    expect(w.subscriptions()).toBe(1);
  });
});

describe('seq contract across every control', () => {
  it('strictly +1 over start/stop/continue/reset/pause/resume/price/shutdown, and getState seq is always the last one', () => {
    const h = build();
    const check = (label: string) => {
      const envs = engineEnvelopes(h.sent);
      for (let i = 1; i < envs.length; i++) expect(envs[i].seq, `${label} #${i} ${envs[i].event.type}`).toBe(envs[i - 1].seq + 1);
      expect(h.service.getState().seq, label).toBe(envs.at(-1)?.seq ?? 0);
    };
    // A scraped price broadcasts items:changed and no envelope, so it must consume no seq.
    const quietPrice = (id: number, label: string) => {
      const n = h.sent.length;
      price(h, id);
      expect(h.sent.slice(n).map(s => s.channel), label).toEqual(['items:changed']);
      check(label);
    };
    quietPrice(9, 'price, no engine');
    expect(engineEnvelopes(h.sent)).toEqual([]);
    h.service.start(); check('start');
    expect(engineEnvelopes(h.sent)[0].seq).toBe(1);
    bagInit(h); check('init');
    quietPrice(1, 'price');
    go(h, TOWN, MAP); bag(h, 1); check('map');
    h.service.pause(); check('pause');
    h.service.resume(); check('resume');
    h.service.reset(); check('reset');
    vi.advanceTimersByTime(60_000); go(h, MAP, TOWN); check('town');
    h.service.start(); check('restart over a live run');
    bagInit(h); check('init 2');
    h.service.stop(); check('stop');
    h.service.stop(); check('double stop');
    const idle = engineEnvelopes(h.sent).at(-1)!.seq;
    quietPrice(2, 'price between runs');
    h.service.start(); check('start after an idle price');
    expect(engineEnvelopes(h.sent).find(e => e.seq > idle)?.event.type).toBe('init_started');
    expect(engineEnvelopes(h.sent).find(e => e.seq > idle)?.seq).toBe(idle + 1);
    h.service.stop(); check('stop 2');
    const doneId = (h.sent.find(s => s.channel === 'engine:event' && (s.payload as EngineEnvelope).event.type === 'session_saved')?.payload as EngineEnvelope | undefined)?.event;
    expect(doneId).toBeDefined();
    h.service.shutdown?.(); check('shutdown');
  });
});

describe('getState() inside a broadcast callback', () => {
  it('after the event is broadcast (not session_saved), snapshot + the remaining envelopes equal the live store', async () => {
    const h = build();
    const taken: Array<{at: EngineEnvelope; snap: EngineSnapshot}> = [];
    h.broadcastHooks.push((channel, payload) => {
      if (channel !== 'engine:event') return;
      const env = payload as EngineEnvelope;
      // session_saved is sent BEFORE the event that caused it (persist precedes broadcast), so it is not a
      // consistent cut point; every other broadcast is sent after the engine's state already includes it.
      if (env.event.type === 'drop') taken.push({at: env, snap: h.service.getState()});
    });
    h.service.start(); bagInit(h); go(h, TOWN, MAP); bag(h, 1); bag(h, 2); bag(h, 3);
    const envelopes = engineEnvelopes(h.sent);
    expect(taken.length).toBeGreaterThanOrEqual(3);

    const ref = await freshStore();
    for (const {event} of envelopes) ref.store.getState().handleEvent(event);
    for (const {at, snap} of taken) {
      expect(snap.seq, 'seq is the drop envelope itself').toBe(at.seq);
      const w = await freshStore();
      const p = w.store.getState().init();
      w.resolveState(snap);
      await p;
      w.deliver(...envelopes.filter(e => e.seq > snap.seq));
      expect(view(w).drops).toEqual(view(ref).drops);
      expect(view(w)).toEqual(view(ref));
    }
  });
});
