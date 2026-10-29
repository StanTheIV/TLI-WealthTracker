/**
 * 4.1a: every stop is observable. `Engine.stop()` emits `engine_stopped` exactly
 * once, LAST, whenever a run existed (initializing, tracking, paused). Never on
 * reset, never for a stop with no run. TrackingService broadcasts it.
 *
 * The event type is not in the `EngineEvent` union yet when this file is written,
 * so events are read through a string-typed helper.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import type {Broadcast} from '@/main/broadcast';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import {engineEvents} from '@/test/broadcast';
import type {RawEvent} from '@/worker/processors/types';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {
  ARCANA_FIGHT, MAP, TEST_IDENTITY, TOWN, boot, createDispatcher, createEngine,
} from './seasonal-fixtures';
import {INV, rig} from './interlude-fixtures';
import {fakeWealthRecorder, fakeWealthSeries} from '@/test/wealth';

const STOPPED = 'engine_stopped';
const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const NOW        = new Date('2026-03-01T12:00:00Z').getTime();

const typeOf  = (e: EngineEvent): string => (e as {type: string}).type;
const kinds   = (evs: EngineEvent[]): string[] => evs.map(typeOf);
const stopped = (evs: EngineEvent[]): number => kinds(evs).filter(t => t === STOPPED).length;
const sessionFinishedAt = (evs: EngineEvent[]): number =>
  evs.findIndex(e => e.type === 'tracker_finished' && e.tracker.kind === 'session');

/** Exactly one `engine_stopped`, and it is the last event. */
function expectStoppedLast(evs: EngineEvent[]): void {
  expect(stopped(evs)).toBe(1);
  expect(typeOf(evs[evs.length - 1])).toBe(STOPPED);
  const ev = evs[evs.length - 1] as unknown as {timestamp: unknown};
  expect(typeof ev.timestamp).toBe('number');
}

/** ...and it comes after the session `tracker_finished`. */
function expectStoppedAfterSessionFinish(evs: EngineEvent[]): void {
  expectStoppedLast(evs);
  const fin = sessionFinishedAt(evs);
  expect(fin).toBeGreaterThanOrEqual(0);
  expect(fin).toBeLessThan(evs.length - 1);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------

describe('Engine.stop — engine_stopped', () => {
  it('during initializing: exactly one, last, and no session tracker_finished', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    engine.start(TEST_IDENTITY);
    expect(kinds(events)).toContain('init_started');
    expect(sessionFinishedAt(events)).toBe(-1);

    engine.stop();
    expectStoppedLast(events);
    expect(sessionFinishedAt(events)).toBe(-1);
  });

  it('while tracking: after the session tracker_finished, last', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    boot(createDispatcher(), engine, INV);
    expect(kinds(events)).toContain('init_complete');

    engine.stop();
    expectStoppedAfterSessionFinish(events);
  });

  it('while paused: after the session tracker_finished, last', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    boot(createDispatcher(), engine, INV);
    engine.pause();

    engine.stop();
    expectStoppedAfterSessionFinish(events);
  });

  it('inside a map: after the session tracker_finished, last', () => {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);
    o.drop(2);
    o.adv(5_000);

    o.e.stop();
    expectStoppedAfterSessionFinish(o.events);
  });

  it('inside an interlude: after the session tracker_finished, last', () => {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);
    o.drop(1);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(5_000);
    o.drop(2);

    o.e.stop();
    expectStoppedAfterSessionFinish(o.events);
  });

  it('stop before any start: nothing', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    engine.stop();
    expect(stopped(events)).toBe(0);
  });

  it('double stop: still exactly one, last', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    boot(createDispatcher(), engine, INV);
    engine.stop();
    engine.stop();
    expectStoppedLast(events);
  });

  it('stop after a stop that happened during initializing: still exactly one', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    engine.start(TEST_IDENTITY);
    engine.stop();
    engine.stop();
    expectStoppedLast(events);
  });

  it('a new run after a stop gets its own engine_stopped on its stop', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    const d = createDispatcher();
    boot(d, engine, INV);
    engine.stop();
    boot(d, engine, INV);
    engine.stop();
    expect(stopped(events)).toBe(2);
    expect(typeOf(events[events.length - 1])).toBe(STOPPED);
  });
});

describe('Engine.reset — never engine_stopped', () => {
  it('reset while tracking', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    boot(createDispatcher(), engine, INV);
    engine.reset(TEST_IDENTITY);
    expect(stopped(events)).toBe(0);
  });

  it('reset while paused', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    boot(createDispatcher(), engine, INV);
    engine.pause();
    engine.reset(TEST_IDENTITY);
    expect(stopped(events)).toBe(0);
  });

  it('reset during initializing (a no-op) emits none either', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    engine.start(TEST_IDENTITY);
    engine.reset(TEST_IDENTITY);
    expect(stopped(events)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TrackingService
// ---------------------------------------------------------------------------

function build() {
  const conn  = openMigratedNodeSqlite();
  const store = new SqliteSessionStore(conn);
  const sent: Array<{channel: string; payload: unknown}> = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const worker = {start: vi.fn<(logPath: string) => void>(), stop: vi.fn<() => void>()};
  const broadcast: Broadcast = (channel, payload) => { sent.push({channel, payload}); };
  const service = new TrackingService({
    createEngine:   emit => createProductionEngine(emit),
    store,
    broadcast,
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => ({torchlightPath: TORCHLIGHT})},
    filters:        {getAll: () => []},
    items:          {
      getAll:             () => [] as ReturnType<TrackingDeps['items']['getAll']>,
      getLocked:          () => false,
      insertIfMissing:    () => true,
      recordScrapedPrice: () => ({priceDate: NOW}),
    },
    wealthRecorder: fakeWealthRecorder(),
    wealthSeries:   fakeWealthSeries(),
    log:            {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
  });
  const raw = (event: RawEvent) => {
    if (!onEvent) throw new Error('createWorker not called');
    onEvent(event);
  };
  const broadcasts = (): EngineEvent[] => engineEvents(sent);
  return {service, raw, broadcasts};
}
type Svc = ReturnType<typeof build>;

function initBag(h: Svc): void {
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});
}

describe('TrackingService — engine_stopped on the engine:event broadcast', () => {
  beforeEach(() => { vi.setSystemTime(NOW); });

  it('stop of a tracking run broadcasts it, last', () => {
    const h = build();
    h.service.start();
    initBag(h);
    h.service.stop();
    expectStoppedLast(h.broadcasts());
  });

  it('stop during initializing broadcasts it (it used to be silent)', () => {
    const h = build();
    h.service.start();
    h.service.stop();
    const evs = h.broadcasts();
    expect(kinds(evs)).toContain('init_started');
    expectStoppedLast(evs);
  });

  it('shutdown of a run broadcasts it', () => {
    const h = build();
    h.service.start();
    initBag(h);
    h.service.shutdown();
    expectStoppedLast(h.broadcasts());
  });

  it('shutdown during initializing broadcasts it', () => {
    const h = build();
    h.service.start();
    h.service.shutdown();
    expectStoppedLast(h.broadcasts());
  });

  it('stop with no run, double stop and shutdown after stop add nothing', () => {
    const h = build();
    h.service.stop();
    expect(stopped(h.broadcasts())).toBe(0);
    h.service.start();
    initBag(h);
    h.service.stop();
    h.service.stop();
    h.service.shutdown();
    expect(stopped(h.broadcasts())).toBe(1);
  });

  it("start while running: the old run's engine_stopped precedes the new init_started", () => {
    const h = build();
    h.service.start();
    initBag(h);
    h.service.start();
    const t = kinds(h.broadcasts());
    const firstStop  = t.indexOf(STOPPED);
    const initStarts = t.flatMap((x, i) => (x === 'init_started' ? [i] : []));
    expect(initStarts).toHaveLength(2);
    expect(firstStop).toBeGreaterThan(t.indexOf('init_complete'));
    expect(firstStop).toBeLessThan(initStarts[1]);
    expect(t.filter(x => x === STOPPED)).toHaveLength(1);
  });

  it('start while initializing: the abandoned run is stopped observably too', () => {
    const h = build();
    h.service.start();
    h.service.start();
    const t = kinds(h.broadcasts());
    const initStarts = t.flatMap((x, i) => (x === 'init_started' ? [i] : []));
    expect(initStarts).toHaveLength(2);
    expect(t.indexOf(STOPPED)).toBeGreaterThan(initStarts[0]);
    expect(t.indexOf(STOPPED)).toBeLessThan(initStarts[1]);
  });
});
