/**
 * 4.4a: session snapshots leave the main process without `dropsBySource`. Both
 * exits — every `engine:event` envelope and every `getState().events` entry —
 * carry the wire form, while the event the engine emitted (the one persistence
 * and the wealth snapshot read) is never mutated and persistence still writes
 * the per-source breakdown. `drops`, `spent` and everything else survive.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import type {Broadcast} from '@/main/broadcast';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {Engine} from '@/main/engine/engine';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEvent, TrackerSnapshot, WireEngineEvent} from '@/shared/contracts/engine';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {engineEnvelopes, type Sent} from '@/test/broadcast';
import {TOWN, MAP, log} from '@/main/engine/__tests__/seasonal-fixtures';
import {createDispatcher} from '@/worker/create-dispatcher';
import {fakeWealthRecorder, fakeWealthSeries} from '@/test/wealth';

const NOW  = new Date('2026-03-01T12:00:00Z').getTime();
const BAG  = 100;
const LOOT = 200;

function build() {
  const store   = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: Sent[] = [];
  const engines: Engine[] = [];
  /** What the engine emitted, and each event's JSON before and after the whole fan-out ran. */
  const emitted: Array<{event: EngineEvent; before: string; after: string}> = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const broadcast: Broadcast = (channel, payload) => { sent.push({channel, payload}); };
  const service = new TrackingService({
    createEngine:   emit => {
      const e = createProductionEngine(event => {
        const before = JSON.stringify(event);
        emit(event);
        emitted.push({event, before, after: JSON.stringify(event)});
      });
      engines.push(e);
      return e;
    },
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
  return {service, store, sent, engines, emitted, raw: (r: RawEvent) => onEvent!(r)};
}
type H = ReturnType<typeof build>;

const dispatcher = createDispatcher();
const line = (h: H, text: string) => { for (const r of dispatcher.dispatch(text)) h.raw(r); };
const go   = (h: H, a: string, b: string) => h.raw({type: 'zone_transition', fromScene: a, toScene: b});
const bag  = (h: H, slotId: number, itemId: number, quantity: number) => h.raw({type: 'bag_update', pageId: 0, slotId, itemId, quantity});

/** A run whose session books drops to two sources (map, carjack) and an entry cost. */
function run(h: H, check: (label: string) => void = () => undefined): void {
  h.service.start();                                                       check('start');
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: BAG, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});                                     check('init');
  bag(h, 1, BAG, 4);                                                       // spent in town...
  vi.advanceTimersByTime(500); go(h, TOWN, MAP);                           check('enter map'); // ...is the entry cost
  vi.advanceTimersByTime(2_000); bag(h, 2, LOOT, 2);                       check('map drop');
  vi.advanceTimersByTime(1_000); line(h, log.s11Start);                    check('carjack start');
  vi.advanceTimersByTime(1_000); bag(h, 2, LOOT, 5);                       check('carjack drop');
  h.service.pause();                                                       check('paused');
  h.service.resume();                                                      check('resumed');
  vi.advanceTimersByTime(5_000); line(h, log.s11End);                      check('carjack end');
  vi.advanceTimersByTime(30_000); go(h, MAP, TOWN);                        check('town');
  vi.advanceTimersByTime(120_000);                                         check('settled');
}

const hasDropsBySource = (e: EngineEvent | WireEngineEvent) => 'tracker' in e && 'dropsBySource' in e.tracker;
const sessionSnapshots = (h: H) => h.emitted
  .map(x => x.event)
  .filter((e): e is Extract<EngineEvent, {tracker: TrackerSnapshot}> => 'tracker' in e && e.tracker.kind === 'session');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('engine:event envelopes', () => {
  it('no envelope carries dropsBySource, though the engine emitted multi-source session snapshots', () => {
    const h = build();
    run(h);
    h.service.stop();

    const multi = sessionSnapshots(h).filter(e => Object.keys(e.tracker.dropsBySource ?? {}).length >= 2);
    expect(multi.length).toBeGreaterThan(0); // not vacuous
    const envs = engineEnvelopes(h.sent);
    expect(envs.length).toBeGreaterThan(20);
    for (const {seq, event} of envs) expect(hasDropsBySource(event), `#${seq} ${event.type}`).toBe(false);
    expect(h.sent.some(s => JSON.stringify(s.payload).includes('dropsBySource'))).toBe(false); // nowhere, any channel
  });

  it('each tracker envelope is the engine\'s event minus dropsBySource — drops, spent and the rest intact', () => {
    const h = build();
    run(h);
    h.service.stop();

    const tracked = h.emitted.map(x => x.event).filter(e => e.type !== 'unit_finished' && 'tracker' in e);
    const sent    = engineEnvelopes(h.sent).map(e => e.event).filter(e => 'tracker' in e);
    expect(sent).toHaveLength(tracked.length);
    let sessions = 0;
    tracked.forEach((event, i) => {
      if (!('tracker' in event)) throw new Error('unreachable');
      const {dropsBySource: _dbs, ...tracker} = event.tracker;
      expect(sent[i], `#${i} ${event.type} ${event.tracker.kind}`).toStrictEqual({...event, tracker});
      if (event.tracker.kind === 'session') sessions++;
    });
    expect(sessions).toBeGreaterThan(3);
    const lastSession = sent.filter(e => 'tracker' in e && e.tracker.kind === 'session').at(-1);
    expect(lastSession && 'tracker' in lastSession && lastSession.tracker.drops).toEqual({[LOOT]: 5});
    expect(lastSession && 'tracker' in lastSession && lastSession.tracker.spent).toEqual({[BAG]: 1});
  });

  it('map and seasonal snapshots (never carrying dropsBySource) pass through as the same object', () => {
    const h = build();
    run(h);
    const others = h.emitted.map(x => x.event).filter(e => e.type !== 'unit_finished' && 'tracker' in e && e.tracker.kind !== 'session');
    expect(others.some(e => 'tracker' in e && e.tracker.kind === 'seasonal')).toBe(true);
    expect(others.some(e => 'tracker' in e && e.tracker.kind === 'map')).toBe(true);
    const sent = new Set(engineEnvelopes(h.sent).map(e => e.event));
    for (const e of others) {
      expect(hasDropsBySource(e)).toBe(false);
      expect(sent.has(e as never), e.type).toBe(true);
    }
  });
});

describe('getState()', () => {
  it('at every step: no entry carries dropsBySource, while the engine\'s own replay still does', () => {
    const h = build();
    let carried = 0;
    run(h, label => {
      const engine = h.engines.at(-1)!;
      const replay = engine.getState();
      const {events} = h.service.getState();
      expect(events, label).toHaveLength(replay.length);
      for (const e of events) expect(hasDropsBySource(e), `${label}: ${e.type}`).toBe(false);
      carried += replay.filter(hasDropsBySource).length;
      // The strip copied: the engine's replay (and its state) is untouched.
      expect(engine.getState(), label).toStrictEqual(replay);
    });
    expect(carried).toBeGreaterThan(0); // not vacuous
  });

  it('the session entry keeps drops and spent', () => {
    const h = build();
    run(h);
    const session = h.service.getState().events.find(e => e.type === 'tracker_started' && e.tracker.kind === 'session');
    expect(session && 'tracker' in session ? session.tracker : null).toMatchObject({drops: {[LOOT]: 5}, spent: {[BAG]: 1}});
  });
});

describe('in-process consumers keep the full snapshot', () => {
  it('no emitted event is mutated by the fan-out (persistence before the broadcast, wealth after it)', () => {
    const h = build();
    run(h);
    h.service.stop();
    expect(h.emitted.filter(x => hasDropsBySource(x.event)).length).toBeGreaterThan(0);
    for (const {event, before, after} of h.emitted) expect(after, event.type).toBe(before);
  });

  it('persistence still writes the per-source breakdown', () => {
    const h = build();
    run(h);
    h.service.stop();
    const [saved] = h.store.listSessions();
    const session = h.store.getSession(saved.id)!;
    const last = sessionSnapshots(h).at(-1)!.tracker.dropsBySource!;
    expect(Object.keys(session.dropsBySource).sort()).toEqual(['carjack', 'map']);
    expect(session.dropsBySource).toEqual(Object.fromEntries(Object.entries(last).map(([source, bucket]) =>
      [source, Object.fromEntries(Object.entries(bucket).map(([id, qty]) => [String(id), qty]))])));
  });
});
