/**
 * 4.2b service side: every `engine:event` broadcast is an envelope
 * `{seq, event}` with one monotonic seq; `TrackingService.getState()` returns
 * `{seq, events}` (the engine's replay + the current seq); a discovered item
 * is announced on `items:changed` before its `new_item` envelope.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import type {Broadcast} from '@/main/broadcast';
import {SqliteSessionStore} from '@/main/db/session-store';
import {Engine} from '@/main/engine/engine';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEnvelope as Envelope, EngineEvent} from '@/shared/contracts/engine';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {engineEnvelopes, type Sent} from '@/test/broadcast';
import {TOWN, MAP} from '@/main/engine/__tests__/seasonal-fixtures';
import {fakeWealthRecorder, fakeWealthSeries} from '@/test/wealth';

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const NOW        = new Date('2026-03-01T12:00:00Z').getTime();
const ITEM_BAG   = 100;
const ITEM_LOOT  = 200;


function build(opts: {insertIfMissing?: (id: string) => boolean} = {}) {
  const store   = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: Sent[] = [];
  const engines: Engine[] = [];
  const engineEmitted: EngineEvent[] = []; // what the engine produced, before broadcast filtering
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const worker = {start: vi.fn<(p: string) => void>(), stop: vi.fn<() => void>()};
  const items = {
    getAll:             vi.fn(() => [] as ReturnType<TrackingDeps['items']['getAll']>),
    getLocked:          vi.fn((_id: string) => false),
    insertIfMissing:    vi.fn(opts.insertIfMissing ?? ((_id: string) => true)),
    recordScrapedPrice: vi.fn<TrackingDeps['items']['recordScrapedPrice']>(() => ({priceDate: NOW})),
  };
  const broadcast: Broadcast = (channel, payload) => { sent.push({channel, payload}); };
  const service = new TrackingService({
    createEngine:   emit => {
      const e = createProductionEngine(ev => { engineEmitted.push(ev); emit(ev); });
      engines.push(e);
      return e;
    },
    store,
    broadcast,
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => ({torchlightPath: TORCHLIGHT})},
    filters:        {getAll: () => []},
    items,
    wealthRecorder: fakeWealthRecorder(),
    wealthSeries:   fakeWealthSeries(),
    log:            {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
  });
  return {service, sent, engines, engineEmitted, items, raw: (r: RawEvent) => onEvent!(r)};
}
type H = ReturnType<typeof build>;

const init = (h: H) => {
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: ITEM_BAG, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});
};
const runMap = (h: H) => {
  h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
  h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 3});
  vi.advanceTimersByTime(60_000);
  h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
};
const rawPrice = (itemId = 555): RawEvent => ({type: 'price_update', itemId, price: 12.5, listings: [12, 13]});

const engineSent = (h: H) => h.sent.filter(s => s.channel === 'engine:event');
const envelopes  = (h: H) => engineEnvelopes(h.sent);
const state      = (h: H) => h.service.getState();

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('engine:event envelope', () => {
  it('every payload is {seq, event}; seq is strictly +1 per broadcast', () => {
    const h = build();
    h.service.start();
    init(h);
    runMap(h);
    h.service.stop();

    const envs = envelopes(h);
    expect(envs.length).toBeGreaterThan(10);
    for (const p of engineSent(h).map(s => s.payload)) {
      expect(Object.keys(p as object).sort()).toEqual(['event', 'seq']);
      expect(typeof (p as Envelope).seq).toBe('number');
      expect(typeof (p as Envelope).event.type).toBe('string');
    }
    for (let i = 1; i < envs.length; i++) expect(envs[i].seq, `#${i} ${envs[i].event.type}`).toBe(envs[i - 1].seq + 1);
    expect(envs.map(e => e.event.type)).toContain('session_saved');
  });

  it('seq never resets across runs (stop -> start -> stop)', () => {
    const h = build();
    h.service.start(); init(h); runMap(h); h.service.stop();
    const firstRunLast = envelopes(h).at(-1)!.seq;
    h.service.start(); init(h); runMap(h); h.service.stop();

    const envs = envelopes(h);
    expect(envs.filter(e => e.event.type === 'init_started')).toHaveLength(2);
    for (let i = 1; i < envs.length; i++) expect(envs[i].seq).toBe(envs[i - 1].seq + 1);
    const second = envs.filter(e => e.event.type === 'init_started')[1];
    expect(second.seq).toBeGreaterThan(firstRunLast);
  });

  it('unit_finished is produced by the engine but never broadcast, and leaves no seq gap', () => {
    const h = build();
    h.service.start(); init(h); runMap(h); h.service.stop();
    expect(h.engineEmitted.some(e => e.type === 'unit_finished')).toBe(true); // not vacuous
    expect(envelopes(h).some(e => (e.event.type as string) === 'unit_finished')).toBe(false);
    const envs = envelopes(h);
    for (let i = 1; i < envs.length; i++) expect(envs[i].seq).toBe(envs[i - 1].seq + 1);
  });

  it('a scraped price is items:changed only — no engine:event, no seq — with or without an engine', () => {
    const h = build();
    const price = (id: number, label: string) => {
      const engineBefore = engineSent(h).length;
      const itemsBefore  = h.sent.filter(s => s.channel === 'items:changed').length;
      h.raw(rawPrice(id));
      expect(engineSent(h), label).toHaveLength(engineBefore);
      expect(h.sent.filter(s => s.channel === 'items:changed'), label).toHaveLength(itemsBefore + 1);
    };
    price(1, 'no engine yet');
    expect(engineSent(h)).toEqual([]);
    h.service.start();
    expect(envelopes(h)[0].seq).toBe(1); // the price consumed no seq
    price(2, 'initializing');
    init(h);
    price(3, 'tracking');
    h.service.stop();
    price(4, 'after stop');

    const envs = envelopes(h);
    for (let i = 1; i < envs.length; i++) expect(envs[i].seq).toBe(envs[i - 1].seq + 1);
    // no raw (un-enveloped) engine:event anywhere
    expect(engineSent(h).every(s => 'seq' in (s.payload as object) && 'event' in (s.payload as object))).toBe(true);
  });

  it('a locked item\'s price broadcasts nothing at all; an unlocked one only items:changed', () => {
    const h = build();
    h.service.start();
    const n = h.sent.length;
    const before = envelopes(h).at(-1)!.seq;
    h.items.getLocked.mockReturnValue(true);
    h.raw(rawPrice());
    expect(h.sent).toHaveLength(n);
    h.items.getLocked.mockReturnValue(false);
    h.raw(rawPrice());
    expect(h.sent.slice(n).map(s => s.channel)).toEqual(['items:changed']);
    expect(envelopes(h).at(-1)!.seq).toBe(before);
  });

  it('non-engine channels are not enveloped', () => {
    const h = build();
    h.raw(rawPrice());
    const items = h.sent.find(s => s.channel === 'items:changed')!;
    expect(items.payload).toEqual({id: '555', changes: {price: 12.5, priceDate: NOW}});
  });
});

describe('TrackingService.getState', () => {
  it('no engine: {seq, events: []} where seq is the last broadcast (0 before any)', () => {
    const h = build();
    expect(state(h)).toEqual({seq: 0, events: []});
    h.raw(rawPrice()); // broadcasts no envelope
    expect(state(h)).toEqual({seq: 0, events: []});
    h.service.start(); init(h); h.service.stop();
    const last = envelopes(h).at(-1)!.seq;
    expect(last).toBeGreaterThan(0);
    expect(state(h)).toEqual({seq: last, events: []});
    h.raw(rawPrice());
    expect(state(h)).toEqual({seq: last, events: []});
  });

  it('after every step: seq = last broadcast seq, events = engine.getState() without dropsBySource', () => {
    const h = build();
    const wire = (e: EngineEvent) => {
      if (!('tracker' in e)) return e;
      const {dropsBySource: _dbs, ...tracker} = e.tracker;
      return {...e, tracker};
    };
    let stripped = 0;
    const check = (label: string) => {
      const envs = envelopes(h);
      const st = state(h);
      expect(st.seq, label).toBe(envs.at(-1)?.seq ?? 0);
      const engine = h.engines.at(-1);
      const replay = engine ? engine.getState() : [];
      stripped += replay.filter(e => 'tracker' in e && 'dropsBySource' in e.tracker).length;
      expect(st.events, label).toStrictEqual(replay.map(wire));
    };
    check('fresh');
    h.service.start();       check('started');
    init(h);                 check('init');
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP}); check('in map');
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 3}); check('drop');
    h.service.pause();       check('paused');
    h.service.resume();      check('resumed');
    h.service.stop();        check('stopped');
    expect(state(h).events).toEqual([]);
    expect(stripped, 'the session replay carried dropsBySource at some step').toBeGreaterThan(0);
  });

  it('a running session replays: init_started first, session tracker present', () => {
    const h = build();
    h.service.start(); init(h); runMap(h);
    const {events} = state(h);
    expect(events[0].type).toBe('init_started');
    expect(events.some(e => e.type === 'tracker_started' && e.tracker.kind === 'session')).toBe(true);
  });

  it('reading the state broadcasts nothing and does not advance seq', () => {
    const h = build();
    h.service.start(); init(h);
    const n = h.sent.length;
    const a = state(h);
    const b = state(h);
    expect(h.sent).toHaveLength(n);
    expect(b).toEqual(a);
  });

  it('is synchronous: seq and events are one consistent read', () => {
    const h = build();
    h.service.start(); init(h);
    const result = state(h);
    expect(result).not.toBeInstanceOf(Promise);
    expect(Object.keys(result).sort()).toEqual(['events', 'seq']);
  });
});

describe('items:changed on discovery', () => {
  const PLACEHOLDER = {name: '', type: 'other', price: 0, priceDate: 0};

  it('a real insert broadcasts the placeholder BEFORE the new_item envelope', () => {
    const h = build();
    h.service.start();
    init(h);
    const iChanged = h.sent.findIndex(s => s.channel === 'items:changed' && (s.payload as {id: string}).id === String(ITEM_BAG));
    const iNew     = h.sent.findIndex(s => s.channel === 'engine:event' && (s.payload as Envelope).event?.type === 'new_item');
    expect(iChanged).toBeGreaterThan(-1);
    expect(iNew).toBeGreaterThan(-1);
    expect(iChanged).toBeLessThan(iNew);
    expect(h.sent[iChanged]).toEqual({channel: 'items:changed', payload: {id: String(ITEM_BAG), changes: PLACEHOLDER}});
  });

  it('no insert (row already existed): no items:changed, the new_item envelope still goes out', () => {
    const h = build({insertIfMissing: () => false});
    h.service.start();
    init(h);
    expect(h.sent.filter(s => s.channel === 'items:changed')).toEqual([]);
    expect(envelopes(h).some(e => e.event.type === 'new_item')).toBe(true);
  });

  it('a throwing insert broadcasts no placeholder but still the new_item envelope', () => {
    const h = build({insertIfMissing: () => { throw new Error('locked db'); }});
    h.service.start();
    init(h);
    expect(h.sent.filter(s => s.channel === 'items:changed')).toEqual([]);
    expect(envelopes(h).some(e => e.event.type === 'new_item')).toBe(true);
  });

  it('one placeholder per inserted item, each before its own new_item', () => {
    const h = build();
    h.service.start();
    h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1});
    h.raw({type: 'bag_init', pageId: 0, slotId: 2, itemId: 2, quantity: 1});
    h.raw({type: 'bag_snapshot_start'});
    for (const id of [1, 2]) {
      const c = h.sent.findIndex(s => s.channel === 'items:changed' && (s.payload as {id: string}).id === String(id));
      const n = h.sent.findIndex(s => s.channel === 'engine:event' && (s.payload as Envelope).event?.type === 'new_item' && ((s.payload as Envelope).event as {itemId?: number}).itemId === id);
      expect(c, `item ${id}`).toBeGreaterThan(-1);
      expect(c).toBeLessThan(n);
    }
  });
});

