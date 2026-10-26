/**
 * The engine builds the saved unit (step 1.6, commit A). Through the production
 * chain under fake timers, every `unit_finished` is checked: which seasonals are
 * children of the map they ran under (a map unit's `overlaps`) and which are
 * STANDALONE units of their own, and when each is emitted. Every event is also
 * replayed into an OwnerWatcher so the owner-publishing invariant keeps holding.
 *
 * Rule under test: a seasonal is a CHILD of the map it was created or active
 * under (`registry.map !== null` at that time, even while the map is frozen for
 * an interlude or a session pause); otherwise it is standalone. A town-opened
 * panel left dormant and never reopened in a map is standalone.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import {OwnerWatcher} from '@/test/owner-invariant';
import {unitIndexes, unitsOf} from '@/test/unit-events';
import {
  ARCANA_FIGHT, boot, createDispatcher, createEngineWithEmit, ctx, feed, log, MAP, SANDLORD_HUB,
  TARTARUS_FIGHT, TOWN, VOREX_REWARD,
} from './seasonal-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const LOOT     = 800;   // slot 1
const MATERIAL = 100;   // slot 2, starts at 10

function rig() {
  const events: EngineEvent[] = [];
  let e!: Engine;
  const w = new OwnerWatcher({writer: () => ctx(e).registry.writer(), store: true});
  e = createEngineWithEmit(ev => { events.push(ev); w.onEmit(ev); });
  const d = createDispatcher();
  boot(d, e, [{slotId: 1, itemId: LOOT, quantity: 0}, {slotId: 2, itemId: MATERIAL, quantity: 10}]);
  let lootTotal = 0;
  return {
    e, d, events, w,
    line: (l: string) => feed(d, e, l),
    go:   (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
    drop: (n = 1) => { lootTotal += n; feed(d, e, log.bagUpdate(1, LOOT, lootTotal)); },
    /** Spend 3 of MATERIAL in town (10 -> 7): the next town -> map entry costs it. */
    spend3: () => feed(d, e, log.bagUpdate(2, MATERIAL, 7)),
    adv:  (ms: number) => vi.advanceTimersByTime(ms),
    units: () => unitsOf(events),
  };
}
type Rig = ReturnType<typeof rig>;

/** A primary unit as `kind` or `kind:seasonalType`. */
const primary = (o: Rig) => o.units().map(u => (u.tracker.kind === 'map' ? 'map' : `seasonal:${u.tracker.seasonalType}`));
const children = (o: Rig, unit = 0) => o.units()[unit].overlaps.map(c => c.tracker.seasonalType);
const finishedTypes = (o: Rig) => o.events.flatMap(ev => (ev.type === 'tracker_finished' && ev.tracker.seasonalType ? [ev.tracker.seasonalType] : []));

describe('standalone units', () => {
  it('a dormant town Arcana (backed out, never reopened) is standalone, ahead of the map unit that follows', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.line(log.s9Close);
    expect(ctx(o.e).registry.seasonal('arcana')?.active).toBe(false);
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.drop(3);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['seasonal:arcana', 'map']);
    expect(o.units()[0].overlaps).toEqual([]);
    expect(o.units()[1].overlaps).toEqual([]);
    expect(o.w.violations).toEqual([]);
  });

  it.each([
    ['vorex',    (o: Rig) => { o.line(log.s13Start); o.go(TOWN, VOREX_REWARD); o.adv(5_000); o.go(VOREX_REWARD, TOWN); }],
    ['tartarus', (o: Rig) => {
      o.line(log.s16BoardOpen); o.line(log.s16SuppressRow); o.line(log.s16Suppress); o.line(log.s16BoardClose); o.line(log.s16BoardCloseTip);
      o.go(TOWN, TARTARUS_FIGHT); o.adv(5_000); o.go(TARTARUS_FIGHT, TOWN);
    }],
    ['arcana',   (o: Rig) => { o.line(log.s9Minigame); o.go(TOWN, ARCANA_FIGHT); o.adv(5_000); o.go(ARCANA_FIGHT, TOWN); }],
    ['sandlord', (o: Rig) => { o.go(TOWN, SANDLORD_HUB); o.adv(5_000); o.go(SANDLORD_HUB, TOWN); }],
  ] as const)('town %s with no map ever is one standalone unit', (type, play) => {
    const o = rig();
    play(o);

    expect(ctx(o.e).registry.map).toBeNull();
    expect(primary(o)).toEqual([`seasonal:${type}`]);
    expect(o.units()[0].overlaps).toEqual([]);
    expect(o.w.violations).toEqual([]);
  });

  it('a standalone unit is emitted after its own tracker_finished', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.go(TOWN, ARCANA_FIGHT);
    o.go(ARCANA_FIGHT, TOWN);

    const finished = o.events.findIndex(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'arcana');
    const [unit] = unitIndexes(o.events);
    expect(finished).toBeGreaterThanOrEqual(0);
    expect(unit).toBeGreaterThan(finished);
  });
});

describe('children of a map', () => {
  it('a town Arcana panel reopened inside the map is a child of that map', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.line(log.s9Close);
    o.go(TOWN, MAP);
    o.adv(5_000);
    o.line(log.s9Minigame);            // reopened in the map: it wakes and the map freezes
    expect(ctx(o.e).registry.seasonal('arcana')?.active).toBe(true);
    o.line(log.s9Close);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['arcana']);
  });

  it('a town panel left OPEN into a map is a child of that map', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.go(TOWN, MAP);
    expect(ctx(o.e).registry.seasonal('arcana')).not.toBeNull();
    expect(ctx(o.e).registry.map).not.toBeNull();
    o.adv(5_000);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['arcana']);
  });

  it('in-map Lunaria and Sandlord parked between strums at finish are children, in finish order', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s14Strum);
    o.drop();
    o.line(log.s10Wave);
    o.drop();
    o.adv(10_100);                     // both windows expired: parked, not finished
    expect(ctx(o.e).registry.seasonal('lunaria')?.active).toBe(false);
    expect(ctx(o.e).registry.seasonal('sandlord')?.active).toBe(false);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['lunaria', 'sandlord']);
    expect(o.units()[0].overlaps[1].tracker.phase).toBe('map');
    expect(o.w.violations).toEqual([]);
  });

  it('an Arcana fight entered from the map (map frozen) is a child, finishing when the fight ends', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    expect(ctx(o.e).registry.map?.active).toBe(false);
    o.adv(20_000);
    o.drop(2);
    o.go(ARCANA_FIGHT, MAP);
    expect(unitsOf(o.events)).toHaveLength(0);      // a child waits for its map
    o.adv(5_000);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['arcana']);
    expect(o.units()[0].overlaps[0].tracker.drops[LOOT]).toBe(2);
  });

  it('an Arcana fight that ends straight in town (map still frozen) is a child of that map', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(5_000);
    o.go(ARCANA_FIGHT, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['arcana']);
  });

  it('map -> Sandlord hub direct: the hub run is a child of the frozen map', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.go(MAP, SANDLORD_HUB);
    expect(ctx(o.e).registry.map?.active).toBe(false);
    o.adv(30_000);
    o.drop(4);
    o.go(SANDLORD_HUB, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['sandlord']);
    expect(o.units()[0].overlaps[0].tracker.phase).toBe('hub');
    expect(o.units()[0].tracker.elapsed).toBe(10_000);   // the hub's time is not map time
    expect(o.w.violations).toEqual([]);
  });

  it('Clockwork podium with no turn-in is a child with no drops', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s7Podium);
    o.adv(5_000);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['clockwork']);
    expect(o.units()[0].overlaps[0].tracker.drops).toEqual({});
  });

  it('a seasonal created under a frozen map (hub entered while the session is paused) is a child; the stamp survives the resume', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(5_000);
    o.e.pause();
    o.go(MAP, SANDLORD_HUB);
    o.adv(30_000);
    o.e.resume();
    o.adv(5_000);
    o.go(SANDLORD_HUB, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['sandlord']);
  });

  it('the stamp survives a session pause and resume of an active in-map seasonal', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s14Strum);
    o.e.pause();
    o.adv(60_000);
    o.e.resume();
    o.adv(1_000);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['lunaria']);
  });

  it('a parked seasonal reactivated after a session pause and resume is still a child', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s14Strum);
    o.adv(5_100);                       // parked
    o.e.pause();
    o.e.resume();
    o.line(log.s14Strum);               // reactivated after the resume
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(children(o)).toEqual(['lunaria']);
  });
});

describe('the map unit', () => {
  it("carries the entry cost on the map's tracker.spent; overlaps carry none", () => {
    const o = rig();
    o.spend3();
    o.go(TOWN, MAP);
    o.line(log.s14Strum);
    o.adv(5_000);
    o.go(MAP, TOWN);

    const [unit] = o.units();
    expect(unit.tracker.spent).toEqual({[MATERIAL]: 3});
    expect(unit.overlaps).toHaveLength(1);
    expect(unit.overlaps[0].tracker.spent ?? {}).toEqual({});
  });

  it("is the same snapshot as the map's own tracker_finished", () => {
    const o = rig();
    o.spend3();
    o.go(TOWN, MAP);
    o.drop(2);
    o.go(MAP, TOWN);

    const mapFinished = o.events.find(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'map');
    expect(mapFinished).toBeDefined();
    expect(o.units()[0].tracker).toEqual((mapFinished as Extract<EngineEvent, {type: 'tracker_finished'}>).tracker);
  });

  it('overlap entries carry their own finish timestamps; the unit carries the map finish', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(20_000);
    o.go(ARCANA_FIGHT, MAP);
    const arcanaFinishedAt = Date.now();
    o.adv(30_000);
    o.line(log.s14Strum);
    o.adv(2_000);
    o.go(MAP, TOWN);
    const mapFinishedAt = Date.now();

    const [unit] = o.units();
    expect(children(o)).toEqual(['arcana', 'lunaria']);
    expect(unit.overlaps.map(c => c.timestamp)).toEqual([arcanaFinishedAt, mapFinishedAt]);
    expect(unit.timestamp).toBe(mapFinishedAt);
  });

  it('two maps in a row: each unit carries only its own children', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s14Strum);
    o.adv(5_100);
    o.go(MAP, TOWN);
    o.go(TOWN, MAP);
    o.line(log.s7Podium);
    o.go(MAP, TOWN);
    o.go(TOWN, MAP);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map', 'map', 'map']);
    expect(children(o, 0)).toEqual(['lunaria']);
    expect(children(o, 1)).toEqual(['clockwork']);
    expect(children(o, 2)).toEqual([]);
  });

  it('a dormant town panel followed by two maps is standalone once and leaks into neither map', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.line(log.s9Close);
    o.go(TOWN, MAP);
    o.go(MAP, TOWN);
    o.go(TOWN, MAP);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['seasonal:arcana', 'map', 'map']);
    expect(o.units().map(u => u.overlaps.length)).toEqual([0, 0, 0]);
  });
});

describe('events around the unit', () => {
  it('every seasonal still emits exactly one tracker_finished of its own, ahead of the map and the unit', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.go(TOWN, ARCANA_FIGHT);
    o.go(ARCANA_FIGHT, TOWN);          // standalone arcana
    o.go(TOWN, MAP);
    o.line(log.s14Strum);
    o.line(log.s7Podium);
    o.go(MAP, TOWN);

    expect(finishedTypes(o).sort()).toEqual(['arcana', 'clockwork', 'lunaria']);
    const at = (pred: (ev: EngineEvent) => boolean) => o.events.findIndex(pred);
    const lunaria = at(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'lunaria');
    const clockwork = at(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'clockwork');
    const mapFinished = at(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'map');
    const [standaloneUnit, mapUnit] = unitIndexes(o.events);
    expect(Math.max(lunaria, clockwork)).toBeLessThan(mapFinished);
    expect(mapFinished).toBeLessThan(mapUnit);
    expect(standaloneUnit).toBeLessThan(mapUnit);
    expect(o.w.violations).toEqual([]);
  });
});

describe('stop and reset', () => {
  it('stop mid-map: already-finished children become standalone units BEFORE the session tracker_finished; live map and seasonals are dropped', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(10_000);
    o.go(ARCANA_FIGHT, MAP);           // arcana finished: a child waiting for its map
    o.line(log.s14Strum);              // lunaria live, map live
    expect(unitsOf(o.events)).toHaveLength(0);
    o.e.stop();

    expect(primary(o)).toEqual(['seasonal:arcana']);
    expect(o.units()[0].overlaps).toEqual([]);
    const sessionFinished = o.events.findIndex(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'session');
    expect(sessionFinished).toBeGreaterThan(unitIndexes(o.events)[0]);
    expect(o.events.some(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'map')).toBe(false);
    expect(finishedTypes(o)).toEqual(['arcana']);
  });

  it('stop mid-map with several finished children emits each as its own standalone unit, in finish order', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.go(ARCANA_FIGHT, MAP);           // arcana finished
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);           // a second arcana run, same type
    o.adv(5_000);
    o.go(ARCANA_FIGHT, MAP);           // finished again
    o.e.stop();

    expect(primary(o)).toEqual(['seasonal:arcana', 'seasonal:arcana']);
    expect(o.units().every(u => u.overlaps.length === 0)).toBe(true);
  });

  it('stop mid-map with nothing finished emits no unit at all', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s14Strum);
    o.e.stop();

    expect(o.units()).toEqual([]);
    expect(o.events.some(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'session')).toBe(true);
  });

  it('a stop does not leak its promoted children into the next run of the same engine', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.go(ARCANA_FIGHT, MAP);
    o.e.stop();
    const before = o.units().length;

    o.e.start();
    expect(o.units()).toHaveLength(before);
    o.e.stop();
    expect(o.units()).toHaveLength(before);
  });

  it('reset mid-map emits NO unit_finished, yet still emits the plain tracker_finished the UI needs', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.go(ARCANA_FIGHT, MAP);           // finished child waiting for its map
    o.line(log.s14Strum);              // live seasonal
    o.e.reset();

    expect(o.units()).toEqual([]);
    expect(finishedTypes(o).sort()).toEqual(['arcana', 'lunaria']);
    expect(o.events.some(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'map')).toBe(true);
    expect(o.w.violations).toEqual([]);
  });

  it('after a reset, the rebuilt map unit carries none of the discarded run\'s children', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.go(ARCANA_FIGHT, MAP);
    o.e.reset();                       // the player is still in the map: it becomes map #1
    o.adv(5_000);
    o.go(MAP, TOWN);

    expect(primary(o)).toEqual(['map']);
    expect(o.units()[0].overlaps).toEqual([]);
  });

  it('reset in town emits no unit', () => {
    const o = rig();
    o.line(log.s9Minigame);
    o.line(log.s9Close);
    o.e.reset();

    expect(o.units()).toEqual([]);
  });
});

// Every snapshot carries the tracker's REAL start (its creation time). It is
// not `finish − elapsed`: elapsed is pause-aware, so that reads late for any
// run that froze or went dormant.
describe('real start time', () => {
  it('a map frozen by an Arcana interlude keeps its real start', () => {
    const o = rig();
    const mapStart = Date.now();
    o.go(TOWN, MAP);
    o.adv(10_000);
    const arcanaStart = Date.now();
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);           // the map freezes for the fight
    o.adv(20_000);
    o.go(ARCANA_FIGHT, MAP);
    o.adv(5_000);
    o.go(MAP, TOWN);

    const [unit] = o.units();
    expect(unit.tracker.elapsed).toBe(15_000);
    expect(unit.tracker.startedAt).toBe(mapStart);
    expect(unit.timestamp - unit.tracker.elapsed).toBe(mapStart + 20_000);   // the old, late derivation
    expect(unit.overlaps[0].tracker.startedAt).toBe(arcanaStart);
  });

  it('a dormant-then-woken seasonal keeps its real start', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(1_000);
    const lunariaStart = Date.now();
    o.line(log.s14Strum);
    o.adv(5_100);                      // window expired: parked (dormant)
    expect(ctx(o.e).registry.seasonal('lunaria')?.active).toBe(false);
    o.adv(30_000);
    o.line(log.s14Strum);              // woken
    o.adv(1_000);
    o.go(MAP, TOWN);

    const [lunaria] = o.units()[0].overlaps;
    expect(lunaria.tracker.seasonalType).toBe('lunaria');
    expect(lunaria.tracker.startedAt).toBe(lunariaStart);
    expect(lunaria.timestamp - lunaria.tracker.elapsed).toBeGreaterThan(lunariaStart);
  });

  it("an overlap's start is its own creation: a town panel reopened in the map starts before its map", () => {
    const o = rig();
    const arcanaStart = Date.now();
    o.line(log.s9Minigame);
    o.line(log.s9Close);               // dormant in town
    o.adv(4_000);
    const mapStart = Date.now();
    o.go(TOWN, MAP);
    o.adv(5_000);
    o.line(log.s9Minigame);            // reopened in the map
    o.line(log.s9Close);
    o.go(MAP, TOWN);

    const [unit] = o.units();
    expect(unit.tracker.startedAt).toBe(mapStart);
    expect(children(o)).toEqual(['arcana']);
    expect(unit.overlaps[0].tracker.startedAt).toBe(arcanaStart);
  });

  it('the map Engine.reset rebuilds is a new tracker: it starts at the reset', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    const resetAt = Date.now();
    o.e.reset();
    o.adv(5_000);
    o.go(MAP, TOWN);

    const [unit] = o.units();
    expect(unit.tracker.kind).toBe('map');
    expect(unit.tracker.startedAt).toBe(resetAt);
    expect(unit.tracker.elapsed).toBe(5_000);
  });
});
