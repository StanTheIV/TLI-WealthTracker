/**
 * 4.4 adversarial: the wire strip across a whole multi-source run (map +
 * seasonal + reset + continue + stop), persistence unaffected by what a
 * broadcast does, `_toWire` identity rules, and price bursts adding no envelopes.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import type {Broadcast} from '@/main/broadcast';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {Engine} from '@/main/engine/engine';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEvent} from '@/shared/contracts/engine';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {engineEnvelopes, engineEvents, type Sent} from '@/test/broadcast';
import {TOWN, MAP, log} from '@/main/engine/__tests__/seasonal-fixtures';
import {createDispatcher} from '@/worker/create-dispatcher';
import {useEngineStore} from '@/state/engineStore';

const NOW  = new Date('2026-03-01T12:00:00Z').getTime();
const BAG  = 100;
const LOOT = 200;

type Mode = 'record' | 'noop' | 'mutate';

function build(mode: Mode = 'record') {
  const store   = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: Sent[] = [];
  const engines: Engine[] = [];
  const emitted: EngineEvent[] = [];
  const snapshots = vi.fn();
  const recordScrapedPrice = vi.fn(() => ({priceDate: NOW}));
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const broadcast: Broadcast = (channel, payload) => {
    if (mode === 'noop') return;
    sent.push({channel, payload});
    if (mode === 'mutate' && channel === 'engine:event') {
      // vandalise everything reachable from the payload
      const walk = (o: unknown): void => {
        if (!o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) { walk((o as Record<string, unknown>)[k]); delete (o as Record<string, unknown>)[k]; }
      };
      walk(payload);
    }
  };
  const service = new TrackingService({
    createEngine: emit => {
      const e = createProductionEngine(ev => { emitted.push(ev); emit(ev); });
      engines.push(e);
      return e;
    },
    store, broadcast,
    createWorker: cb => { onEvent = cb; return {start: vi.fn(), stop: vi.fn()} satisfies LogWorker; },
    settings: {getAll: () => ({torchlightPath: 'C:/Games/TLI'})},
    filters:  {getAll: () => []},
    items: {
      getAll: () => [], getLocked: () => false, insertIfMissing: () => true, recordScrapedPrice,
    } as unknown as TrackingDeps['items'],
    wealthRecorder: {snapshot: snapshots},
    log: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
  });
  return {service, store, sent, engines, emitted, snapshots, recordScrapedPrice, raw: (r: RawEvent) => onEvent!(r)};
}
type H = ReturnType<typeof build>;

const dispatcher = createDispatcher();
const line = (h: H, t: string) => { for (const r of dispatcher.dispatch(t)) h.raw(r); };
const go   = (h: H, a: string, b: string) => h.raw({type: 'zone_transition', fromScene: a, toScene: b});
const bag  = (h: H, slotId: number, itemId: number, quantity: number) => h.raw({type: 'bag_update', pageId: 0, slotId, itemId, quantity});

function deepHas(o: unknown, key: string): boolean {
  if (!o || typeof o !== 'object') return false;
  if (key in (o as object)) return true;
  return Object.values(o as object).some(v => deepHas(v, key));
}

function bootRun(h: H): void {
  h.service.start();
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: BAG, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});
  bag(h, 1, BAG, 4);
}
/** map + concurrent seasonal + interlude; check() after every step. */
function segment(h: H, check: (l: string) => void, loot = 2): void {
  vi.advanceTimersByTime(500); go(h, TOWN, MAP);             check('enter');
  vi.advanceTimersByTime(2_000); bag(h, 2, LOOT, loot);      check('map drop');
  vi.advanceTimersByTime(1_000); line(h, log.s11Start);      check('seasonal start');
  vi.advanceTimersByTime(1_000); bag(h, 2, LOOT, loot + 3);  check('seasonal drop');
  vi.advanceTimersByTime(5_000); line(h, log.s11End);        check('seasonal end');
  vi.advanceTimersByTime(30_000); go(h, MAP, TOWN);          check('town');
  vi.advanceTimersByTime(120_000);                           check('settled');
}
/** Whole lifecycle: run, reset, run, stop, continue, run, stop. */
function lifecycle(h: H, check: (l: string) => void = () => undefined): void {
  bootRun(h);                       check('boot');
  segment(h, check);
  h.service.reset();                check('reset');
  segment(h, check, 4);
  h.service.stop();                 check('stop');
  const [saved] = h.store.listSessions();
  h.service.continueSession(saved.id); check('continue');
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: BAG, quantity: 5});
  h.raw({type: 'bag_snapshot_start'});
  segment(h, check, 7);
  h.service.stop();                 check('stop2');
}
const persisted = (h: H) => h.store.listSessions().map(s => {
  const {id: _i, name: _n, ...rest} = h.store.getSession(s.id) as unknown as Record<string, unknown>;
  void _i; void _n;
  return rest;
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('whole lifecycle', () => {
  it('no envelope and no getState() at any step carries dropsBySource anywhere (deep)', () => {
    const h = build();
    let engineHad = 0;
    lifecycle(h, label => {
      const st = h.service.getState();
      expect(deepHas(st, 'dropsBySource'), `getState ${label}`).toBe(false);
      const eng = h.engines.at(-1);
      if (eng) engineHad += eng.getState().filter(e => deepHas(e, 'dropsBySource')).length;
    });
    expect(engineHad).toBeGreaterThan(0);
    const envs = engineEnvelopes(h.sent);
    expect(envs.length).toBeGreaterThan(40);
    for (const e of envs) expect(deepHas(e, 'dropsBySource'), `#${e.seq} ${e.event.type}`).toBe(false);
    expect(h.sent.some(s => JSON.stringify(s.payload).includes('dropsBySource'))).toBe(false);
    // continued-session seed was exercised and is stripped
    const cont = envs.filter(e => e.event.type === 'tracker_started' && e.event.tracker.kind === 'session'
      && e.event.sessionMeta?.continued);
    expect(cont.length).toBeGreaterThan(0);
    // finished trackers too
    expect(envs.some(e => e.event.type === 'tracker_finished' && e.event.tracker.kind === 'session')).toBe(true);
    // seq contiguous
    envs.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('wire session drops/spent equal the in-process ones at every tracker event', () => {
    const h = build();
    lifecycle(h);
    const inproc = h.emitted.filter(e => e.type !== 'unit_finished' && 'tracker' in e);
    const wire = engineEvents(h.sent).filter(e => 'tracker' in e);
    expect(wire).toHaveLength(inproc.length);
    expect(inproc.length).toBeGreaterThan(20);
    inproc.forEach((e, i) => {
      const w = wire[i];
      if (!('tracker' in e) || !('tracker' in w)) throw new Error('shape');
      expect(w.type).toBe(e.type);
      expect(w.tracker.drops).toEqual(e.tracker.drops);
      expect(w.tracker.spent).toEqual(e.tracker.spent);
      expect(w.tracker.elapsed).toBe(e.tracker.elapsed);
    });
  });

  it('persistence is byte-identical whatever the broadcast does (record / no-op / vandalising)', () => {
    const out: string[] = [];
    for (const mode of ['noop', 'record', 'mutate'] as Mode[]) {
      vi.setSystemTime(NOW);
      const h = build(mode);
      lifecycle(h);
      const p = persisted(h);
      expect(p.length).toBeGreaterThan(0);
      expect(JSON.stringify(p)).toContain('carjack');
      out.push(JSON.stringify(p));
    }
    expect(out[1]).toBe(out[0]);
    expect(out[2]).toBe(out[0]);
  });

  it('getState() hands out copies of the stripped session entries: vandalising one does not leak into the next', () => {
    const h = build();
    bootRun(h);
    segment(h, () => undefined);
    const first = h.service.getState();
    const sessions = first.events.filter(e => 'tracker' in e && e.tracker.kind === 'session');
    expect(sessions.length).toBeGreaterThan(0);
    for (const ev of sessions) if ('tracker' in ev) { ev.tracker.drops = {}; ev.tracker.elapsed = -1; }
    const second = h.service.getState().events.filter(e => 'tracker' in e && e.tracker.kind === 'session');
    for (const e of second) if ('tracker' in e) expect(e.tracker.elapsed).not.toBe(-1);
    expect(second.some(e => 'tracker' in e && Object.keys(e.tracker.drops).length > 0)).toBe(true);
  });

  it('the wealth recorder still sees the full state after each _send', () => {
    const h = build();
    const seen: boolean[] = [];
    h.snapshots.mockImplementation((eng: Engine) => { seen.push(eng.getState().some(e => deepHas(e, 'dropsBySource'))); });
    bootRun(h);
    segment(h, () => undefined);
    h.service.stop();
    expect(h.snapshots).toHaveBeenCalled();
    expect(seen.some(Boolean)).toBe(true);
  });
});

describe('_toWire identity', () => {
  it('events without a tracker pass as the same object; session trackers become a new object', () => {
    const h = build();
    bootRun(h);
    segment(h, () => undefined);
    const inproc = h.emitted.filter(e => e.type !== 'unit_finished');
    const wire = new Set<unknown>(engineEvents(h.sent));
    let same = 0, copied = 0;
    for (const e of inproc) {
      const needsCopy = 'tracker' in e && 'dropsBySource' in e.tracker;
      if (needsCopy) { expect(wire.has(e), e.type).toBe(false); copied++; }
      else { expect(wire.has(e), e.type).toBe(true); same++; }
    }
    expect(same).toBeGreaterThan(0);
    expect(copied).toBeGreaterThan(0);
  });

  it('getState() never hands out the engine\'s own session objects', () => {
    const h = build();
    bootRun(h);
    segment(h, () => undefined);
    const replay = h.engines.at(-1)!.getState();
    const a = h.service.getState().events;
    for (const e of a) expect(replay.includes(e as never) && 'tracker' in e && e.tracker.kind === 'session').toBe(false);
  });
});

describe('price_update', () => {
  it('a burst of scraped prices adds zero engine envelopes, keeps seq contiguous, and the store matches replay', () => {
    const quiet = build();
    bootRun(quiet);
    segment(quiet, () => undefined);
    const baseline = engineEnvelopes(quiet.sent).length;

    const h = build();
    bootRun(h);
    vi.advanceTimersByTime(500); go(h, TOWN, MAP);
    for (let i = 0; i < 50; i++) h.raw({type: 'price_update', itemId: 555 + (i % 3), price: i, listings: [i]});
    vi.advanceTimersByTime(2_000); bag(h, 2, LOOT, 2);
    for (let i = 0; i < 50; i++) h.raw({type: 'price_update', itemId: LOOT, price: i, listings: [i]});
    vi.advanceTimersByTime(1_000); line(h, log.s11Start);
    vi.advanceTimersByTime(1_000); bag(h, 2, LOOT, 5);
    vi.advanceTimersByTime(5_000); line(h, log.s11End);
    vi.advanceTimersByTime(30_000); go(h, MAP, TOWN);
    vi.advanceTimersByTime(120_000);

    const envs = engineEnvelopes(h.sent);
    expect(envs).toHaveLength(baseline);
    envs.forEach((e, i) => expect(e.seq).toBe(i + 1));
    expect(h.sent.filter(s => s.channel === 'items:changed').length).toBeGreaterThanOrEqual(100);
    expect(JSON.stringify(h.sent.filter(s => s.channel === 'engine:event'))).not.toContain('price_update');

    // renderer: live-fed store vs replay-built store
    const norm = () => {
      const s = useEngineStore.getState();
      return JSON.stringify({
        phase: s.phase, drops: s.drops, spent: s.sessionSpent, zone: s.currentZone,
        mapCount: s.mapCount, id: s.activeSessionId,
        map: s.mapTracker && {d: s.mapTracker.drops, a: s.mapTracker.active},
        seasonal: [...s.seasonalTrackers.entries()].map(([k, v]) => [k, v.drops, v.active]),
      });
    };
    useEngineStore.getState().reset();
    for (const e of envs) useEngineStore.getState().handleEvent(e.event);
    const live = norm();
    useEngineStore.getState().reset();
    useEngineStore.getState().applySnapshot(h.service.getState());
    const replayed = norm();
    expect(replayed).toBe(live);
    expect(live).toContain('"drops":{"200":5}');
  });
});
