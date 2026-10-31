/**
 * 5.1b: TrackingService — atomic _start, typed rules from the DB via
 * applyActiveFilter, guarded worker events, safe reset ordering. Real engine +
 * real SqliteSessionStore (node:sqlite); everything else faked. Engine
 * misbehaviour is injected by spying on the real engine the service creates.
 */
import {describe, it, expect, beforeEach, afterEach, vi, type Mock, type MockInstance} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {Engine} from '@/main/engine/engine';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {DbSession} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {FilterRule, ItemFilter} from '@/shared/item-filter';
import {engineEvents, type Sent} from '@/test/broadcast';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {fakeWealthRecorder, fakeWealthSeries} from '@/test/wealth';
import {describeError} from '@/shared/describe-error';

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const NOW        = new Date('2026-03-01T12:00:00Z').getTime();

const RULES: FilterRule[] = [{id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session']}];
const activeFilter = (rules: FilterRule[] = RULES): ItemFilter => ({id: 'f1', name: 'Mine', enabled: true, rules});

interface Harness {
  service: TrackingService;
  store:   SqliteSessionStore;
  sent:    Sent[];
  raw:     (event: RawEvent) => void;
  items: {
    getAll:             Mock<() => ReturnType<TrackingDeps['items']['getAll']>>;
    getLocked:          Mock<(id: string) => boolean>;
    recordScrapedPrice: Mock<TrackingDeps['items']['recordScrapedPrice']>;
  };
  filtersGetAll: Mock<() => ItemFilter[]>;
  log:      {debug: Mock; info: Mock; warn: Mock; error: Mock};
  engines:  Engine[];
}

function build(tweak: (e: Engine) => void = () => undefined): Harness {
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: Sent[] = [];
  const engines: Engine[] = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const worker = {start: vi.fn(), stop: vi.fn()};
  const items = {
    getAll:             vi.fn(() => [] as ReturnType<TrackingDeps['items']['getAll']>),
    getLocked:          vi.fn((_id: string) => false),
    recordScrapedPrice: vi.fn<TrackingDeps['items']['recordScrapedPrice']>(() => ({priceDate: NOW})),
  };
  const filtersGetAll = vi.fn<() => ItemFilter[]>(() => []);
  const log = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const service = new TrackingService({
    createEngine:   emit => { const e = createProductionEngine(emit); tweak(e); engines.push(e); return e; },
    store,
    broadcast:      (channel, payload) => { sent.push({channel, payload}); },
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => ({torchlightPath: TORCHLIGHT})},
    filters:        {getAll: filtersGetAll},
    items:          {...items, insertIfMissing: () => true},
    wealthRecorder: fakeWealthRecorder(),
    wealthSeries:   fakeWealthSeries(),
    log,
  });
  return {service, store, sent, raw: e => onEvent!(e), items, filtersGetAll, log, engines};
}

/** One-slot bag dump closed by a snapshot marker → immediate init (the session row is live). */
function init(h: Harness): void {
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});
}

const types = (h: Harness): string[] => engineEvents(h.sent).map((e: EngineEvent) => e.type);

function savedSession(): DbSession {
  return {
    id: 'old', name: 'My run', savedAt: '2026-02-01T10:00:00.000Z', totalTime: 120, mapTime: 100, mapCount: 2,
    drops: {'300': 4}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {}, spent: {},
    endedAt: Date.parse('2026-02-01T10:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('_start atomicity — config read before the run in progress is touched', () => {
  type Starter = [string, (h: Harness) => void];
  const starters: Starter[] = [
    ['start',           h => h.service.start()],
    ['continueSession', h => { h.store.insertSession(savedSession()); h.service.continueSession('old'); }],
  ];
  const breakers: Array<[string, (h: Harness) => void]> = [
    ['filters.getAll', h => h.filtersGetAll.mockImplementation(() => { throw new Error('corrupt filter f1'); })],
    ['items.getAll',   h => h.items.getAll.mockImplementation(() => { throw new Error('items unreadable'); })],
  ];

  describe.each(starters)('%s', (_name, begin) => {
    it.each(breakers)('a throwing %s with a run in progress leaves it untouched', (_b, breakIt) => {
      const h = build();
      h.service.start();
      const id = h.service.getActiveSessionId();
      const engine = h.engines[0];
      const stopSpy = vi.spyOn(engine, 'stop');
      const before = types(h).length;
      breakIt(h);

      expect(() => begin(h)).toThrow();
      expect(h.service.isTracking()).toBe(true);
      expect(h.service.getActiveSessionId()).toBe(id);
      expect(h.engines).toHaveLength(1);
      expect(stopSpy).not.toHaveBeenCalled();
      expect(types(h).slice(before)).not.toContain('engine_stopped');
    });

    it.each(breakers)('a throwing %s with no run at all leaves the service idle', (_b, breakIt) => {
      const h = build();
      breakIt(h);
      expect(() => begin(h)).toThrow();
      expect(h.service.isTracking()).toBe(false);
      expect(h.service.getActiveSessionId()).toBeNull();
    });
  });
});

describe('_start failure after stop — back to idle, logged, rethrown', () => {
  it.each<[string, (e: Engine) => void]>([
    ['engine.start', e => { vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('start boom'); }); }],
    ['engine.configure', e => { vi.spyOn(e, 'configure').mockImplementation(() => { throw new Error('start boom'); }); }],
  ])('a throwing %s', (_n, tweak) => {
    const h = build(tweak);
    expect(() => h.service.start()).toThrow('start boom');
    expect(h.service.isTracking()).toBe(false);
    expect(h.service.getActiveSessionId()).toBeNull();
    expect(h.log.error.mock.calls.some(c => String(c[1]).includes('start boom'))).toBe(true);
  });

  it('a throw during a restart (run in progress, then failure after stop) ends idle', () => {
    let n = 0;
    const h = build(e => { if (++n === 2) vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('second start boom'); }); });
    h.service.start();
    expect(() => h.service.start()).toThrow('second start boom');
    expect(h.service.isTracking()).toBe(false);
    expect(h.service.getActiveSessionId()).toBeNull();
  });

  it('a later start works after a failed one', () => {
    let n = 0;
    const h = build(e => { if (++n === 1) vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('boom'); }); });
    expect(() => h.service.start()).toThrow('boom');
    h.service.start();
    expect(h.service.isTracking()).toBe(true);
  });
});

describe('typed rules from the DB', () => {
  it('the engine receives the active filter\'s typed rules at start', () => {
    let spy!: MockInstance<Engine['setFilterRules']>;
    const h = build(e => { spy = vi.spyOn(e, 'setFilterRules'); });
    h.filtersGetAll.mockReturnValue([{...activeFilter([]), id: 'off', enabled: false}, activeFilter()]);
    h.service.start();
    expect(spy).toHaveBeenLastCalledWith(RULES);
  });

  it('no enabled filter: the engine is configured with null', () => {
    let spy!: MockInstance<Engine['setFilterRules']>;
    const h = build(e => { spy = vi.spyOn(e, 'setFilterRules'); });
    h.service.start();
    expect(spy).toHaveBeenLastCalledWith(null);
  });

  it('applyActiveFilter re-reads deps.filters and applies the active rules, then null', () => {
    let spy!: MockInstance<Engine['setFilterRules']>;
    const h = build(e => { spy = vi.spyOn(e, 'setFilterRules'); });
    h.service.start();
    const apply = () => h.service.applyActiveFilter();
    h.filtersGetAll.mockReturnValue([activeFilter()]);
    apply();
    expect(spy).toHaveBeenLastCalledWith(RULES);
    h.filtersGetAll.mockReturnValue([{...activeFilter(), enabled: false}]);
    apply();
    expect(spy).toHaveBeenLastCalledWith(null);
  });

  it('applyActiveFilter is a no-op without an engine', () => {
    const h = build();
    const apply = () => h.service.applyActiveFilter();
    expect(apply).not.toThrow();
    expect(h.filtersGetAll).not.toHaveBeenCalled();
  });

  it('the public setFilterRules is gone', () => {
    const h = build();
    expect('setFilterRules' in h.service).toBe(false);
  });
});

describe('_onWorkerEvent guard', () => {
  const price: RawEvent = {type: 'price_update', itemId: 100, price: 5, listings: [5]} as RawEvent;

  it.each<[string, (h: Harness) => void]>([
    ['recordScrapedPrice', h => h.items.recordScrapedPrice.mockImplementation(() => { throw new Error('price boom'); })],
    ['getLocked',          h => h.items.getLocked.mockImplementation(() => { throw new Error('price boom'); })],
  ])('a throwing items.%s is logged (price) and swallowed', (_n, breakIt) => {
    const h = build();
    breakIt(h);
    expect(() => h.raw(price)).not.toThrow();
    const call = h.log.error.mock.calls.find(c => c[0] === 'price');
    expect(call).toBeDefined();
    expect(String(call![1])).toContain('price boom');
  });

  it('a throwing engine.onRawEvent is logged (engine) and swallowed', () => {
    const h = build();
    h.service.start();
    vi.spyOn(h.engines[0], 'onRawEvent').mockImplementation(() => { throw new Error('raw boom'); });
    expect(() => h.raw({type: 'bag_snapshot_start'})).not.toThrow();
    const call = h.log.error.mock.calls.find(c => c[0] === 'engine' && String(c[1]).includes('raw boom'));
    expect(call).toBeDefined();
  });

  it('a price failure does not stop later events', () => {
    const h = build();
    h.items.recordScrapedPrice.mockImplementationOnce(() => { throw new Error('once'); });
    h.raw(price);
    h.raw(price);
    expect(h.items.recordScrapedPrice).toHaveBeenCalledTimes(2);
  });
});

describe('reset() ordering and failure handling', () => {
  function running(tweak?: (e: Engine) => void): {h: Harness; oldId: string} {
    const h = build(tweak);
    h.service.start();
    init(h);
    return {h, oldId: h.service.getActiveSessionId()!};
  }

  it('the old session is deleted only AFTER engine.reset', () => {
    const {h, oldId} = running();
    const order: string[] = [];
    const realReset = h.engines[0].reset.bind(h.engines[0]);
    vi.spyOn(h.engines[0], 'reset').mockImplementation(id => { order.push('engine.reset'); realReset(id); });
    const realDelete = h.store.deleteSession.bind(h.store);
    vi.spyOn(h.store, 'deleteSession').mockImplementation(id => { order.push(`delete:${id}`); realDelete(id); });
    h.service.reset();
    expect(order).toEqual(['engine.reset', `delete:${oldId}`]);
    expect(h.store.getSession(oldId)).toBeNull();
  });

  it('a throwing engine.reset: idle, old session closed not deleted, error rethrown', () => {
    const {h, oldId} = running();
    vi.spyOn(h.engines[0], 'reset').mockImplementation(() => { throw new Error('reset boom'); });
    const del = vi.spyOn(h.store, 'deleteSession');
    const close = vi.spyOn(h.store, 'closeSession');
    expect(() => h.service.reset()).toThrow('reset boom');
    expect(h.service.isTracking()).toBe(false);
    expect(del).not.toHaveBeenCalled();
    expect(close.mock.calls.some(c => c[0] === oldId)).toBe(true);
    expect(h.store.getSession(oldId)).not.toBeNull();
    expect(h.log.error.mock.calls.some(c => String(c[1]).includes('reset boom'))).toBe(true);
  });

  it('a throwing store.deleteSession after a good reset is swallowed and logged; the new run continues', () => {
    const {h, oldId} = running();
    const err = new Error('delete boom');
    vi.spyOn(h.store, 'deleteSession').mockImplementation(() => { throw err; });
    const close = vi.spyOn(h.store, 'closeSession');
    expect(() => h.service.reset()).not.toThrow();
    expect(h.service.isTracking()).toBe(true);
    expect(h.service.getActiveSessionId()).not.toBe(oldId);
    expect(h.log.error.mock.calls.some(c => String(c[1]).includes(describeError(err).split('\n')[0]))).toBe(true);
    expect(close.mock.calls.some(c => c[0] === oldId)).toBe(true);
  });
});
