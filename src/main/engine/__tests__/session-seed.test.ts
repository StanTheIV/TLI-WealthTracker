/**
 * Step 2.1b — Continue seeds the session tracker from the saved session through
 * `Tracker.seed({drops, dropsBySource, spent, timeOffsetMs})`: after init the
 * session snapshot equals the seeded values, elapsed starts at totalTime, and
 * new loot adds on top with `dropsBySource` staying consistent with `drops`.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import {Tracker} from '@/main/engine/tracker';
import {checkCheckpoints} from '@/test/unit-invariant';
import {MAP, TOWN, createDispatcher, createEngine, ctx, feed, log} from './seasonal-fixtures';
import {bootSession, sessionStarts, unitsWithCheckpoint, type SeedData} from './identity-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const LOOT     = 800;
const OTHER    = 900;
const MATERIAL = 100;

const SAVED: SeedData = {
  sessionId: 'saved-1', name: 'Saved',
  drops:         {[LOOT]: 3, [OTHER]: 7},
  dropsBySource: {map: {[LOOT]: 3, [OTHER]: 4}, arcana: {[OTHER]: 3}},
  spent:         {[MATERIAL]: 5},
  totalTime: 120, mapTime: 30, mapCount: 2,
};

const INV = [{slotId: 1, itemId: LOOT, quantity: 0}, {slotId: 2, itemId: MATERIAL, quantity: 10}];

function rig(loaded: SeedData | undefined = SAVED) {
  const events: EngineEvent[] = [];
  const e: Engine = createEngine(events);
  const d = createDispatcher();
  bootSession(d, e, INV, {loaded});
  let lootTotal = 0;
  return {
    e, d, events,
    go:     (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
    drop:   (n = 1) => { lootTotal += n; feed(d, e, log.bagUpdate(1, LOOT, lootTotal)); },
    spend3: () => feed(d, e, log.bagUpdate(2, MATERIAL, 7)),
    adv:    (ms: number) => vi.advanceTimersByTime(ms),
    session: () => ctx(e).registry.session!.snapshot(),
  };
}

describe('continue: seeded session state', () => {
  it('tracker_started carries the seeded drops, dropsBySource, spent and elapsed = totalTime', () => {
    const {events} = rig();
    const [started] = sessionStarts(events);
    expect(started.tracker.drops).toEqual({[LOOT]: 3, [OTHER]: 7});
    expect(started.tracker.dropsBySource).toEqual({map: {[LOOT]: 3, [OTHER]: 4}, arcana: {[OTHER]: 3}});
    expect(started.tracker.spent).toEqual({[MATERIAL]: 5});
    expect(started.tracker.elapsed).toBe(120_000);
  });

  it('the live session snapshot equals the seeded values', () => {
    const o = rig();
    const s = o.session();
    expect(s.drops).toEqual({[LOOT]: 3, [OTHER]: 7});
    expect(s.dropsBySource).toEqual(SAVED.dropsBySource);
    expect(s.spent).toEqual({[MATERIAL]: 5});
    expect(s.elapsed).toBe(120_000);
  });

  it('seeds the counters: mapCount and accumulated map time (seconds -> ms)', () => {
    const {e} = rig();
    expect(ctx(e).mapCount).toBe(2);
    expect(ctx(e).accumulatedMapTime).toBe(30_000);
    expect(ctx(e).loadedSession).toBeNull();
  });

  it('elapsed keeps running from the offset', () => {
    const o = rig();
    o.adv(5_000);
    expect(o.session().elapsed).toBe(125_000);
  });

  it('seeding does not leak into the bag baseline: no drop events for the seed', () => {
    const {events} = rig();
    expect(events.filter(ev => ev.type === 'drop')).toEqual([]);
  });

  it('new loot adds on top, and dropsBySource stays consistent with drops', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.drop(2);
    const s = o.session();

    expect(s.drops).toEqual({[LOOT]: 5, [OTHER]: 7});
    expect(s.dropsBySource).toEqual({map: {[LOOT]: 5, [OTHER]: 4}, arcana: {[OTHER]: 3}});
    const sums: Record<string, number> = {};
    for (const bucket of Object.values(s.dropsBySource ?? {})) {
      for (const [id, q] of Object.entries(bucket)) sums[id] = (sums[id] ?? 0) + q;
    }
    expect(sums).toEqual({[LOOT]: 5, [OTHER]: 7});
  });

  it('the next map is map #3: its unit checkpoint stacks on the seed', () => {
    const o = rig();
    o.spend3();
    o.go(TOWN, MAP);
    o.adv(20_000);
    o.drop(2);
    o.go(MAP, TOWN);

    const [u] = unitsWithCheckpoint(o.events);
    expect(u.checkpoint.mapCount).toBe(3);
    expect(u.checkpoint.mapTime).toBe(50_000);
    expect(u.checkpoint.session.drops).toEqual({[LOOT]: 5, [OTHER]: 7});
    expect(u.checkpoint.session.spent).toEqual({[MATERIAL]: 8});
    expect(u.checkpoint.session.dropsBySource).toEqual({map: {[LOOT]: 5, [OTHER]: 4}, arcana: {[OTHER]: 3}});
    expect(u.tracker.drops).toEqual({[LOOT]: 2});       // the map itself starts empty
    expect(u.tracker.spent).toEqual({[MATERIAL]: 3});
    expect(checkCheckpoints(o.events)).toEqual([]);
  });

  it('stop reports seeded + new totals in the session tracker_finished', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.drop(1);
    o.go(MAP, TOWN);
    o.e.stop();

    const fin = o.events.find(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'session');
    if (fin?.type !== 'tracker_finished') throw new Error('no session finish');
    expect(fin.tracker.drops).toEqual({[LOOT]: 4, [OTHER]: 7});
    expect(fin.sessionMeta).toEqual({mapTime: 40_000, mapCount: 3});
  });

  it('an empty seed leaves the session empty (no spurious dropsBySource/spent)', () => {
    const o = rig({...SAVED, drops: {}, dropsBySource: {}, spent: {}, totalTime: 0, mapTime: 0, mapCount: 0});
    const s = o.session();
    expect(s.drops).toEqual({});
    expect(s.dropsBySource).toBeUndefined();
    expect(s.spent).toBeUndefined();
    expect(s.elapsed).toBe(0);
  });

  it('a run started after a continue is not seeded', () => {
    const o = rig();
    o.e.stop();
    bootSession(o.d, o.e, INV, {identity: {sessionId: 'fresh', name: 'Fresh'}});
    const s = o.session();
    expect(s.drops).toEqual({});
    expect(s.spent).toBeUndefined();
    expect(s.elapsed).toBe(0);
  });
});

describe('Tracker.seed', () => {
  type Seed = {
    drops:         Record<string, number>;
    dropsBySource: Record<string, Record<string, number>>;
    spent:         Record<string, number>;
    timeOffsetMs:  number;
  };
  const seed = (t: Tracker, s: Seed) => t.seed(s);

  const FULL: Seed = {
    drops:         {100: 3, 200: 7},
    dropsBySource: {map: {100: 3, 200: 4}, arcana: {200: 3}},
    spent:         {300: 2},
    timeOffsetMs:  90_000,
  };

  it('fills drops, dropsBySource and spent', () => {
    const t = new Tracker('session');
    seed(t, FULL);
    const s = t.snapshot();
    expect(s.drops).toEqual({100: 3, 200: 7});
    expect(s.dropsBySource).toEqual({map: {100: 3, 200: 4}, arcana: {200: 3}});
    expect(s.spent).toEqual({300: 2});
    expect(t.entryCost.get(300)).toBe(2);
  });

  it('offsets elapsed and keeps it running; pause/resume honour the offset', () => {
    const t = new Tracker('session');
    seed(t, FULL);
    expect(t.elapsed()).toBe(90_000);
    vi.advanceTimersByTime(4_000);
    expect(t.elapsed()).toBe(94_000);
    t.pause();
    vi.advanceTimersByTime(10_000);
    expect(t.elapsed()).toBe(94_000);
    t.resume();
    vi.advanceTimersByTime(1_000);
    expect(t.elapsed()).toBe(95_000);
  });

  it('later drops add on top of the seed, in drops and in the source bucket', () => {
    const t = new Tracker('session');
    seed(t, FULL);
    t.addDrop(100, 2);
    t.addDropToSource('map', 100, 2);
    t.addDrop(999, 1);
    t.addDropToSource('lunaria', 999, 1);
    t.addCost(300, 1);
    const s = t.snapshot();
    expect(s.drops).toEqual({100: 5, 200: 7, 999: 1});
    expect(s.dropsBySource).toEqual({map: {100: 5, 200: 4}, arcana: {200: 3}, lunaria: {999: 1}});
    expect(s.spent).toEqual({300: 3});
  });

  it('an all-empty seed changes nothing observable', () => {
    const fresh = new Tracker('session').snapshot();
    const t = new Tracker('session');
    seed(t, {drops: {}, dropsBySource: {}, spent: {}, timeOffsetMs: 0});
    expect(t.snapshot()).toEqual(fresh);
  });

  it('copies its input: mutating the seed object afterwards does not touch the tracker', () => {
    const input: Seed = {
      drops: {100: 3}, dropsBySource: {map: {100: 3}}, spent: {300: 2}, timeOffsetMs: 1_000,
    };
    const t = new Tracker('session');
    seed(t, input);
    input.drops[100] = 999;
    input.dropsBySource.map[100] = 999;
    input.spent[300] = 999;
    const s = t.snapshot();
    expect(s.drops[100]).toBe(3);
    expect(s.dropsBySource?.map?.[100]).toBe(3);
    expect(s.spent?.[300]).toBe(2);
  });

  it('a snapshot of a seeded tracker is a copy: mutating it does not touch the tracker', () => {
    const t = new Tracker('session');
    seed(t, FULL);
    const s = t.snapshot();
    s.drops[100] = 0;
    if (s.dropsBySource?.map) s.dropsBySource.map[100] = 0;
    expect(t.snapshot().drops[100]).toBe(3);
    expect(t.snapshot().dropsBySource?.map?.[100]).toBe(3);
  });

  it('does not touch startedAt', () => {
    const t = new Tracker('session');
    const at = t.startedAt;
    vi.advanceTimersByTime(1_000);
    seed(t, FULL);
    expect(t.startedAt).toBe(at);
  });
});
