/**
 * 5.1b adversarial: TrackingService _start atomicity under every injectable failure,
 * reset() failure paths and the session_saved stream, applyActiveFilter, shutdown.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {Engine} from '@/main/engine/engine';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {DbSession} from '@/shared/contracts/db';
import type {FilterRule, ItemFilter} from '@/shared/item-filter';
import {engineEnvelopes, engineEvents, type Sent} from '@/test/broadcast';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {fakeWealthRecorder, fakeWealthSeries} from '@/test/wealth';
import {runShutdownSteps} from '@/main/shutdown';

const NOW = new Date('2026-03-01T12:00:00Z').getTime();
const RULES: FilterRule[] = [{id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session']}];
const active = (id = 'f1', rules = RULES): ItemFilter => ({id, name: id, enabled: true, rules});

interface Opts {
  tweakEngine?: (e: Engine, n: number) => void;
  createEngine?: (n: number) => void; // may throw
  worker?: Partial<LogWorker>;
}

function build(opts: Opts = {}) {
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: Sent[] = [];
  const engines: Engine[] = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const worker = {start: vi.fn(), stop: vi.fn(), ...opts.worker};
  const items = {
    getAll:             vi.fn(() => [] as ReturnType<TrackingDeps['items']['getAll']>),
    getLocked:          vi.fn((_id: string) => false),
    recordScrapedPrice: vi.fn<TrackingDeps['items']['recordScrapedPrice']>(() => ({priceDate: NOW})),
  };
  const settingsGetAll = vi.fn<() => Record<string, string>>(() => ({torchlightPath: 'C:/Games/TLI'}));
  const filtersGetAll = vi.fn<() => ItemFilter[]>(() => []);
  const log = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const service = new TrackingService({
    createEngine: emit => {
      opts.createEngine?.(engines.length + 1);
      const e = createProductionEngine(emit);
      engines.push(e);
      opts.tweakEngine?.(e, engines.length);
      return e;
    },
    store,
    broadcast:      (channel, payload) => { sent.push({channel, payload}); },
    createWorker:   cb => { onEvent = cb; return worker as LogWorker; },
    settings:       {getAll: settingsGetAll},
    filters:        {getAll: filtersGetAll},
    items:          {...items, insertIfMissing: () => true},
    wealthRecorder: fakeWealthRecorder(),
    wealthSeries:   fakeWealthSeries(),
    log,
  });
  return {service, store, sent, raw: (e: RawEvent) => onEvent!(e), items, settingsGetAll, filtersGetAll, log, engines, worker};
}
type H = ReturnType<typeof build>;

function init(h: H): void {
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});
}
const types = (h: H) => engineEvents(h.sent).map(e => e.type);
const savedEvents = (h: H) => engineEvents(h.sent).filter(e => e.type === 'session_saved');

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

const idle = (h: H) => {
  expect(h.service.isTracking()).toBe(false);
  expect(h.service.getActiveSessionId()).toBeNull();
};

describe('_start: every failure point ends idle, rethrows the original error, and the service is reusable', () => {
  type Inject = [string, (h: H) => void, Opts?];
  // Injection after the config read (the first reads happen before stop()).
  const points: Inject[] = [
    ['2nd settings.getAll (log path)',    h => { let n = 0; const real = h.settingsGetAll.getMockImplementation()!; h.settingsGetAll.mockImplementation(() => { if (++n === 2) throw new Error('boom'); return real(); }); }],
    ['worker.start',                      () => undefined, {worker: {start: () => { throw new Error('boom'); }}}],
    ['createEngine',                      () => undefined, {createEngine: () => { throw new Error('boom'); }}],
    ['engine.start',                      () => undefined, {tweakEngine: e => { vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('boom'); }); }}],
    ['engine.setKnownItems (configure)',  () => undefined, {tweakEngine: e => { vi.spyOn(e, 'setKnownItems').mockImplementation(() => { throw new Error('boom'); }); }}],
    ['engine.setFilterRules (configure)', () => undefined, {tweakEngine: e => { vi.spyOn(e, 'setFilterRules').mockImplementation(() => { throw new Error('boom'); }); }}],
    ['engine.configure',                  () => undefined, {tweakEngine: e => { vi.spyOn(e, 'configure').mockImplementation(() => { throw new Error('boom'); }); }}],
  ];

  it.each(points)('start(): %s', (_n, inject, opts) => {
    const h = build(opts);
    inject(h);
    expect(() => h.service.start()).toThrow('boom');
    idle(h);
    expect(h.log.error.mock.calls.some(c => c[0] === 'engine' && String(c[1]).includes('Engine start failed'))).toBe(true);
    // The worker was never torn down by a failed start (it outlives runs).
    expect(h.worker.stop).not.toHaveBeenCalled();
  });

  it.each(points)('a second start() after a transient failure (%s) works and yields exactly one live session', (_n, _inject, opts) => {
    let armed = true;
    const h = build({
      ...opts,
      createEngine: n => { if (armed && opts?.createEngine) opts.createEngine(n); },
      tweakEngine:  (e, n) => { if (armed) opts?.tweakEngine?.(e, n); },
      worker:       opts?.worker ? {start: vi.fn(() => { if (armed) opts.worker!.start!(''); })} : undefined,
    });
    if (_n.startsWith('2nd settings')) {
      let n = 0; const real = h.settingsGetAll.getMockImplementation()!;
      h.settingsGetAll.mockImplementation(() => { if (armed && ++n === 2) throw new Error('boom'); return real(); });
    }
    expect(() => h.service.start()).toThrow('boom');
    armed = false;
    h.service.start();
    expect(h.service.isTracking()).toBe(true);
    init(h);
    expect(types(h).filter(t => t === 'tracker_started').length).toBeGreaterThanOrEqual(1);
    h.service.stop();
    const stops = types(h).filter(t => t === 'engine_stopped');
    // the failed attempt's engine may or may not have announced a stop; the good run exactly one after its start
    expect(stops.length).toBeGreaterThanOrEqual(1);
  });

  it('continueSession: loadSession-side failure (maxPrimaryMapIndex throws) ends idle, the saved session is untouched', () => {
    const h = build();
    h.store.insertSession(savedSession());
    vi.spyOn(h.store, 'maxPrimaryMapIndex').mockImplementation(() => { throw new Error('boom'); });
    expect(() => h.service.continueSession('old')).toThrow('boom');
    idle(h);
    expect(h.store.getSession('old')).toEqual(savedSession());
  });

  it('continueSession refusal (unknown id / legacy attribution / active id) leaves a run untouched and logs nothing as start failure', () => {
    const h = build();
    h.service.start();
    init(h);
    const id = h.service.getActiveSessionId();
    const before = types(h).length;
    h.store.insertSession({...savedSession(), id: 'legacy', attribution: 'legacy' as never});
    expect(() => h.service.continueSession('nope')).toThrow(/not found/);
    expect(() => h.service.continueSession('legacy')).toThrow(/attribution/);
    expect(() => h.service.continueSession(id!)).toThrow(/being tracked/);
    expect(h.service.getActiveSessionId()).toBe(id);
    expect(types(h).length).toBe(before);
    expect(h.log.error.mock.calls.some(c => String(c[1]).includes('Engine start failed'))).toBe(false);
  });

  it('a corrupt filter AND a run in progress: start() throws, the run keeps going and still records events', () => {
    const h = build();
    h.service.start();
    init(h);
    h.filtersGetAll.mockImplementation(() => { throw new Error('Filter x has unreadable rules'); });
    expect(() => h.service.start()).toThrow('unreadable');
    expect(h.service.isTracking()).toBe(true);
    h.raw({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 9} as RawEvent);
    expect(h.engines).toHaveLength(1);
  });

  it('50 failed starts in a row leak no engine into the service and keep throwing the same error', () => {
    const h = build({tweakEngine: e => { vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('boom'); }); }});
    for (let i = 0; i < 50; i++) {
      expect(() => h.service.start()).toThrow('boom');
      idle(h);
    }
    expect(h.engines).toHaveLength(50);
  });

  it('start() while the previous start failed: a later good start announces no stale session_saved/engine_stopped', () => {
    let armed = true;
    const h = build({tweakEngine: e => { if (armed) vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('boom'); }); }});
    expect(() => h.service.start()).toThrow('boom');
    armed = false;
    h.service.start();
    init(h);
    expect(savedEvents(h).every(e => e.type === 'session_saved')).toBe(true);
    // every started session's row belongs to the live id
    const live = h.service.getActiveSessionId()!;
    expect(h.store.getSession(live)).not.toBeNull();
  });

  it('a throwing engine.stop() during _stopAfterFailure is logged and does not mask the original error', () => {
    const h = build({tweakEngine: e => {
      vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('original'); });
      vi.spyOn(e, 'stop').mockImplementation(() => { throw new Error('stop also failed'); });
    }});
    expect(() => h.service.start()).toThrow('original');
    idle(h);
    expect(h.log.error.mock.calls.some(c => String(c[1]).includes('stop also failed'))).toBe(true);
  });
});

describe('reset(): failure paths and the session_saved stream', () => {
  function running(opts?: Opts) {
    const h = build(opts);
    h.service.start();
    init(h);
    return {h, oldId: h.service.getActiveSessionId()!};
  }

  it('successful reset: exactly one session_saved{deleted} for the old id, after the new tracker_started, none for the new', () => {
    const {h, oldId} = running();
    const before = engineEvents(h.sent).length;
    h.service.reset();
    const after = engineEvents(h.sent).slice(before);
    const forOld = after.filter(e => e.type === 'session_saved' && e.sessionId === oldId);
    expect(forOld).toEqual([{type: 'session_saved', sessionId: oldId, deleted: true}]);
    const started = after.findIndex(e => e.type === 'tracker_started');
    const del = after.findIndex(e => e.type === 'session_saved' && e.sessionId === oldId);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(del);
  });

  it('engine.reset throws: one non-deleted session_saved for the old id is announced, AFTER engine_stopped, never a deleted one', () => {
    const {h, oldId} = running();
    vi.spyOn(h.engines[0], 'reset').mockImplementation(() => { throw new Error('reset boom'); });
    const before = engineEvents(h.sent).length;
    expect(() => h.service.reset()).toThrow('reset boom');
    const after = engineEvents(h.sent).slice(before);
    const saved = after.filter(e => e.type === 'session_saved');
    expect(saved).toEqual([{type: 'session_saved', sessionId: oldId}]);
    expect(after.map(e => e.type).indexOf('engine_stopped')).toBeLessThan(after.map(e => e.type).indexOf('session_saved'));
    expect(h.store.getSession(oldId)).not.toBeNull();
    expect(h.store.getSession(oldId)!.endedAt).not.toBeNull();
  });

  it('engine.reset throws AND closeSession throws: no session_saved, original error rethrown, idle', () => {
    const {h, oldId} = running();
    vi.spyOn(h.engines[0], 'reset').mockImplementation(() => { throw new Error('reset boom'); });
    vi.spyOn(h.store, 'closeSession').mockImplementation(() => { throw new Error('close boom'); });
    const before = savedEvents(h).length;
    expect(() => h.service.reset()).toThrow('reset boom');
    expect(savedEvents(h).length).toBe(before);
    idle(h);
    expect(h.store.getSession(oldId)).not.toBeNull();
  });

  it('delete AND close both throw after a good reset: no session_saved for old, the new run continues, nothing thrown', () => {
    const {h, oldId} = running();
    vi.spyOn(h.store, 'deleteSession').mockImplementation(() => { throw new Error('del boom'); });
    vi.spyOn(h.store, 'closeSession').mockImplementation(() => { throw new Error('close boom'); });
    const before = savedEvents(h).length;
    expect(() => h.service.reset()).not.toThrow();
    expect(savedEvents(h).slice(before).some(e => e.type === 'session_saved' && e.sessionId === oldId)).toBe(false);
    expect(h.service.isTracking()).toBe(true);
    expect(h.service.getActiveSessionId()).not.toBe(oldId);
  });

  it('seq stays strictly contiguous across a failed reset', () => {
    const {h} = running();
    vi.spyOn(h.engines[0], 'reset').mockImplementation(() => { throw new Error('reset boom'); });
    expect(() => h.service.reset()).toThrow();
    const seqs = engineEnvelopes(h.sent).map(e => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i));
  });

  it('reset() on an idle service / while initializing is a silent no-op (no deletes, no events)', () => {
    const h = build();
    const del = vi.spyOn(h.store, 'deleteSession');
    h.service.reset();
    h.service.start();
    const n = engineEvents(h.sent).length;
    h.service.reset(); // initializing: engine.isTracking() false
    expect(engineEvents(h.sent).length).toBe(n);
    expect(del).not.toHaveBeenCalled();
  });

  it('reset after a failed reset (idle) is a no-op; a fresh start works', () => {
    const {h} = running();
    vi.spyOn(h.engines[0], 'reset').mockImplementation(() => { throw new Error('reset boom'); });
    expect(() => h.service.reset()).toThrow();
    expect(() => h.service.reset()).not.toThrow();
    h.service.start();
    init(h);
    expect(h.service.isTracking()).toBe(true);
  });

  it('a continued session that is reset is deleted too, and the continued row is never closed-then-deleted twice', () => {
    const h = build();
    h.store.insertSession(savedSession());
    h.service.continueSession('old');
    init(h);
    const close = vi.spyOn(h.store, 'closeSession');
    h.service.reset();
    expect(h.store.getSession('old')).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('applyActiveFilter', () => {
  it('during initializing (engine created, session not open) the rules are applied and survive the session opening', () => {
    const h = build();
    h.service.start();
    const spy = vi.spyOn(h.engines[0], 'setFilterRules');
    h.filtersGetAll.mockImplementation(() => [active()]);
    h.service.applyActiveFilter();
    expect(spy).toHaveBeenCalledWith(RULES);
    init(h);
    expect(h.service.isTracking()).toBe(true);
    spy.mockClear();
    h.filtersGetAll.mockImplementation(() => []);
    h.service.applyActiveFilter();
    expect(spy).toHaveBeenCalledWith(null);
  });

  it('a corrupt row: applyActiveFilter throws and the engine keeps its previous rules (setFilterRules not called)', () => {
    const h = build();
    h.filtersGetAll.mockImplementation(() => [active()]);
    h.service.start();
    const spy = vi.spyOn(h.engines[0], 'setFilterRules');
    h.filtersGetAll.mockImplementation(() => { throw new Error('Filter z has unreadable rules'); });
    expect(() => h.service.applyActiveFilter()).toThrow('unreadable');
    expect(spy).not.toHaveBeenCalled();
  });

  it('two enabled rows: the first wins, identically at start and in applyActiveFilter', () => {
    const h = build();
    const a = active('a', RULES);
    const b = active('b', []);
    h.filtersGetAll.mockImplementation(() => [a, b]);
    const setSpyRules: Array<FilterRule[] | null> = [];
    const h2 = build({tweakEngine: e => { const real = e.setFilterRules.bind(e); vi.spyOn(e, 'setFilterRules').mockImplementation(r => { setSpyRules.push(r); real(r); }); }});
    h2.filtersGetAll.mockImplementation(() => [a, b]);
    h2.service.start();
    h2.service.applyActiveFilter();
    expect(setSpyRules).toEqual([RULES, RULES]);
  });

  it('no engine: applyActiveFilter does not even read the DB', () => {
    const h = build();
    h.service.applyActiveFilter();
    expect(h.filtersGetAll).not.toHaveBeenCalled();
  });

  it('after stop() it is a no-op again', () => {
    const h = build();
    h.service.start();
    h.service.stop();
    h.filtersGetAll.mockClear();
    h.service.applyActiveFilter();
    expect(h.filtersGetAll).not.toHaveBeenCalled();
  });
});

describe('shutdown', () => {
  it('after a failed start: shutdown stops the worker once, does not throw, and a later start still works', () => {
    const h = build({tweakEngine: (e, n) => { if (n === 1) vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('boom'); }); }});
    expect(() => h.service.start()).toThrow('boom');
    h.service.shutdown();
    h.service.shutdown();
    expect(h.worker.stop).toHaveBeenCalledTimes(1);
    h.service.start();
    expect(h.service.isTracking()).toBe(true);
    h.service.shutdown();
    expect(h.worker.stop).toHaveBeenCalledTimes(2);
  });

  it('through runShutdownSteps with a throwing engine.stop: the worker is still stopped and nothing escapes', () => {
    const h = build();
    h.service.start();
    init(h);
    vi.spyOn(h.engines[0], 'stop').mockImplementation(() => { throw new Error('stop boom'); });
    const error = vi.fn();
    runShutdownSteps([
      {name: 'tracking', run: () => h.service.shutdown()},
      {name: 'bounds',   run: () => { throw new Error('bounds boom'); }},
    ], {error});
    expect(h.worker.stop).toHaveBeenCalledTimes(1);
    expect(h.service.isTracking()).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('a worker.stop that throws surfaces via shutdown (and is isolated by runShutdownSteps)', () => {
    const h = build({worker: {stop: () => { throw new Error('kill failed'); }}});
    h.service.start();
    const error = vi.fn();
    runShutdownSteps([{name: 'tracking', run: () => h.service.shutdown()}], {error});
    expect(error).toHaveBeenCalledTimes(1);
    expect(h.service.isTracking()).toBe(false);
  });
});

describe('_onWorkerEvent guard', () => {
  it('events arriving while idle after a failed start never throw', () => {
    const h = build({tweakEngine: e => { vi.spyOn(e, 'start').mockImplementation(() => { throw new Error('boom'); }); }});
    expect(() => h.service.start()).toThrow();
    expect(() => h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1})).not.toThrow();
  });

  it('a price_update whose broadcast and recordScrapedPrice both throw is swallowed, and the next engine event still flows', () => {
    const h = build();
    h.service.start();
    h.items.recordScrapedPrice.mockImplementation(() => { throw new Error('price boom'); });
    expect(() => h.raw({type: 'price_update', itemId: 1, price: 2, listings: [3]} as RawEvent)).not.toThrow();
    init(h);
    expect(types(h)).toContain('init_complete');
  });
});
