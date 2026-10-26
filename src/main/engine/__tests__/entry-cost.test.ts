/**
 * Step 1.2 (test-first) — entry cost lives on the MAP tracker.
 *
 * Production chain (seasonal-fixtures) end to end. Rule under test: at a
 * town -> map transition the town buffer's NEGATIVES are the map's entry cost
 * (positive magnitudes on `TrackerSnapshot.spent`); the cost is never booked
 * as negative drops, never credited to the writer/seasonal, never published as
 * a `drop` event, and ignores the item filter. The buffer's POSITIVES are town
 * activity and credit nothing. Anything that is not town -> map starts no cost.
 *
 * APIs expected from the implementation (all absent today; reached via casts so
 * this file typechecks):
 *   - `TrackerSnapshot.spent?: Record<number, number>`  (src/shared/contracts/engine.ts),
 *     present only when non-empty; map = its entry cost, session = running total.
 *   - `Tracker`: `addCost(itemId, qty)`, `setEntryCost(ReadonlyMap<number, number>)`,
 *     `get entryCost(): ReadonlyMap<number, number>`  (src/main/engine/tracker.ts).
 *   - `TrackerRegistry.chargeEntryCost(cost: ReadonlyMap<number, number>)`
 *     -> `map.setEntryCost` + `session.addCost`, no filter.
 *
 * Arithmetic used throughout: item 100 (material) starts at 10 in the bag.
 * Spending it in town sets the slot to an absolute count, so 10 -> 7 is the
 * delta -3, i.e. a cost of 3.
 *
 * Tests marked PASS-today pin behaviour that must survive the change.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import type {FilterRule} from '@/shared/item-filter';
import {Tracker} from '@/main/engine/tracker';
import {TrackerRegistry} from '@/main/engine/tracker-registry';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, TARTARUS_FIGHT, TOWN, VOREX_REWARD,
  boot, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {UNKNOWN_SCENE, dropEvents, dropsBySource, sessionDrops} from './location-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const MATERIAL = 100;
const LOOT     = 200;
const VENDOR   = 300;
const HIDDEN   = 500;

const S_MATERIAL = 1;
const S_LOOT     = 2;
const S_VENDOR   = 3;
const S_HIDDEN   = 4;

type WithSpent = TrackerSnapshot & {spent?: Record<number, number>};
const spentOf = (snap: TrackerSnapshot | null | undefined): Record<number, number> | undefined =>
  (snap as WithSpent | null | undefined)?.spent;

function setup(extra: Array<{slotId: number; itemId: number; quantity: number}> = []) {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [
    {slotId: S_MATERIAL, itemId: MATERIAL, quantity: 10},
    {slotId: S_LOOT,     itemId: LOOT,     quantity: 0},
    {slotId: S_VENDOR,   itemId: VENDOR,   quantity: 0},
    {slotId: S_HIDDEN,   itemId: HIDDEN,   quantity: 10},
    ...extra,
  ]);
  events.length = 0;
  return {
    events, d, e,
    line:   (l: string) => feed(d, e, l),
    bag:    (slot: number, id: number, qty: number) => feed(d, e, log.bagUpdate(slot, id, qty)),
    go:     (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
    mapSnap:     () => ctx(e).registry.map?.snapshot(),
    sessionSnap: () => ctx(e).registry.session?.snapshot(),
  };
}

/** Spend 3 of MATERIAL in the town buffer (10 -> 7). */
const spend3 = (s: ReturnType<typeof setup>) => s.bag(S_MATERIAL, MATERIAL, 7);

const finishedOf = (events: EngineEvent[], kind: TrackerSnapshot['kind']) =>
  events.flatMap(ev => ev.type === 'tracker_finished' && ev.tracker.kind === kind ? [ev.tracker] : []);

/** Most recent snapshot of `kind` carried by any tracker event. */
function lastSnapshot(events: EngineEvent[], kind: TrackerSnapshot['kind']): TrackerSnapshot | undefined {
  let last: TrackerSnapshot | undefined;
  for (const ev of events) {
    if ((ev.type === 'tracker_started' || ev.type === 'tracker_update' || ev.type === 'tracker_finished') && ev.tracker.kind === kind) {
      last = ev.tracker;
    }
  }
  return last;
}

const dropsFor = (events: EngineEvent[], itemId: number) =>
  events.filter(ev => ev.type === 'drop' && ev.itemId === itemId);

// ---------------------------------------------------------------------------

describe('town -> map: the buffer becomes the map entry cost', () => {
  it('map snapshot carries spent; map/session drops do not contain it; no drop event', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);

    expect(spentOf(s.mapSnap())).toEqual({[MATERIAL]: 3});
    expect(s.mapSnap()?.drops).toEqual({});
    expect(sessionDrops(s.e)).toEqual({});
    expect(dropsBySource(s.e)).toEqual({});
    expect(dropEvents(s.events)).toEqual([]);
  });

  it('session spent is the running total of map entry costs', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);
    expect(spentOf(s.sessionSnap())).toEqual({[MATERIAL]: 3});
  });

  it('publishes the charge: tracker_update for the map and for the session carry spent', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);

    expect(spentOf(lastSnapshot(s.events, 'map'))).toEqual({[MATERIAL]: 3});
    expect(spentOf(lastSnapshot(s.events, 'session'))).toEqual({[MATERIAL]: 3});
    const updates = s.events.filter(ev => ev.type === 'tracker_update');
    expect(updates.some(ev => ev.type === 'tracker_update' && ev.tracker.kind === 'map' && spentOf(ev.tracker)?.[MATERIAL] === 3)).toBe(true);
    expect(updates.some(ev => ev.type === 'tracker_update' && ev.tracker.kind === 'session' && spentOf(ev.tracker)?.[MATERIAL] === 3)).toBe(true);
  });

  it('buffer positives (a vendor purchase) are town activity: not credited, not cost', () => {
    const s = setup();
    spend3(s);                         // -3 material  -> cost 3
    s.bag(S_VENDOR, VENDOR, 7);        // +7 vendor    -> town activity
    s.go(TOWN, MAP);

    expect(spentOf(s.mapSnap())).toEqual({[MATERIAL]: 3});   // no VENDOR key
    expect(s.mapSnap()?.drops).toEqual({});
    expect(sessionDrops(s.e)).toEqual({});
    expect(dropsBySource(s.e)).toEqual({});
    expect(dropsFor(s.events, VENDOR)).toEqual([]);
    expect(dropsFor(s.events, MATERIAL)).toEqual([]);
  });

  it('loot picked up after entry is still credited normally (+5)', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);
    s.bag(S_LOOT, LOOT, 5);

    expect(s.mapSnap()?.drops).toEqual({[LOOT]: 5});
    expect(sessionDrops(s.e)).toEqual({[LOOT]: 5});
    expect(spentOf(s.mapSnap())).toEqual({[MATERIAL]: 3});
  });

  it('a spend made inside the map (not in the entry buffer) is loot: negative drop, no cost [PASS-today]', () => {
    const s = setup();
    s.go(TOWN, MAP);
    s.bag(S_MATERIAL, MATERIAL, 8);    // -2 in map, flushed immediately

    expect(s.mapSnap()?.drops).toEqual({[MATERIAL]: -2});
    expect(spentOf(s.mapSnap())).toBeUndefined();
    expect(spentOf(s.sessionSnap())).toBeUndefined();
  });

  it('purchases that already settled (1500 ms timer) before entry are not cost [PASS-today]', () => {
    const s = setup();
    spend3(s);
    vi.advanceTimersByTime(2_000);     // town timer discards the buffer
    s.go(TOWN, MAP);

    expect(spentOf(s.mapSnap())).toBeUndefined();
    expect(s.mapSnap()?.drops).toEqual({});
  });

  it('a map entered with nothing bought carries no cost, not its predecessor\'s basket [PASS-today]', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);
    s.go(MAP, TOWN);
    s.go(TOWN, MAP);

    expect(spentOf(s.mapSnap())).toBeUndefined();
    expect(s.mapSnap()?.drops).toEqual({});
  });

  it('session spent = sum of the map costs over two maps (map 1: 3 + 0, map 2: 1 + 2)', () => {
    const s = setup();
    spend3(s);                              // map 1: MATERIAL 3
    s.go(TOWN, MAP);
    s.go(MAP, TOWN);

    s.bag(S_MATERIAL, MATERIAL, 6);         // 7 -> 6 : cost 1
    s.bag(S_VENDOR, VENDOR, 0);             // vendor 0 -> 0: no delta (bag init had 0); keep slot warm
    s.bag(S_HIDDEN, HIDDEN, 8);             // 10 -> 8 : cost 2
    s.go(TOWN, MAP);

    expect(spentOf(s.mapSnap())).toEqual({[MATERIAL]: 1, [HIDDEN]: 2});
    s.go(MAP, TOWN);

    // MATERIAL 3 + 1 = 4, HIDDEN 0 + 2 = 2
    expect(spentOf(s.sessionSnap())).toEqual({[MATERIAL]: 4, [HIDDEN]: 2});
    expect(sessionDrops(s.e)).toEqual({});
    const maps = finishedOf(s.events, 'map');
    expect(maps.map(spentOf)).toEqual([{[MATERIAL]: 3}, {[MATERIAL]: 1, [HIDDEN]: 2}]);
  });
});

// ---------------------------------------------------------------------------

describe('cost ignores the item filter', () => {
  const hide = (itemId: number): FilterRule => ({
    id: `hide-${itemId}`, action: 'hide', kind: {type: 'by-item', itemId: String(itemId)},
    scopes: ['session', 'map', 'arcana', 'vorex', 'sandlord'],
  });

  it('a hidden item still counts as spent (map and session); hidden loot is still hidden', () => {
    const s = setup();
    s.e.setFilterRules([hide(HIDDEN)]);
    s.bag(S_HIDDEN, HIDDEN, 6);        // 10 -> 6 : cost 4, hidden by the filter
    spend3(s);                         // visible material, cost 3
    s.go(TOWN, MAP);

    expect(spentOf(s.mapSnap())).toEqual({[HIDDEN]: 4, [MATERIAL]: 3});
    expect(spentOf(s.sessionSnap())).toEqual({[HIDDEN]: 4, [MATERIAL]: 3});

    // Filter keeps working for loot: +2 hidden item in the map is not credited.
    s.bag(S_HIDDEN, HIDDEN, 8);
    expect(s.mapSnap()?.drops).toEqual({});
    expect(sessionDrops(s.e)).toEqual({});
  });

  it('a by-type rule hiding the material type does not drop the cost either', () => {
    const s = setup();
    s.e.setItemType(String(MATERIAL), 'ember');
    s.e.setFilterRules([{
      id: 'hide-ember', action: 'hide', kind: {type: 'by-type', itemType: 'ember'},
      scopes: ['session', 'map'],
    }]);
    spend3(s);
    s.go(TOWN, MAP);

    expect(spentOf(s.mapSnap())).toEqual({[MATERIAL]: 3});
    expect(spentOf(s.sessionSnap())).toEqual({[MATERIAL]: 3});
  });
});

// ---------------------------------------------------------------------------

describe('town -> anything but a map starts no cost and credits nothing', () => {
  const CASES: Array<[string, string, (s: ReturnType<typeof setup>) => void, string | null]> = [
    ['Arcana fight scene', ARCANA_FIGHT,   s => s.line(log.s9Minigame), 'arcana'],
    ['Vorex reward zone',  VOREX_REWARD,   s => s.line(log.s13Start),   'vorex'],
    ['Tartarus prison',    TARTARUS_FIGHT, s => { s.line(log.s16BoardOpen); s.line(log.s16Suppress); }, 'tartarus'],
    ['Sandlord hub',       SANDLORD_HUB,   () => {},                    'sandlord'],
  ];

  it.each(CASES)('%s: buffer (spend 3 + vendor +7) is discarded, nothing credited, no spent', (_n, scene, prep, type) => {
    const s = setup();
    prep(s);
    spend3(s);
    s.bag(S_VENDOR, VENDOR, 7);
    s.go(TOWN, scene);

    expect(ctx(s.e).registry.map).toBeNull();
    expect(sessionDrops(s.e)).toEqual({});
    expect(dropsBySource(s.e)).toEqual({});
    expect(dropEvents(s.events)).toEqual([]);
    expect(spentOf(s.sessionSnap())).toBeUndefined();
    if (type) {
      const seasonal = ctx(s.e).registry.seasonal(type as 'arcana');
      expect(seasonal, `${type} must be live (harness precondition)`).not.toBeNull();
      expect(seasonal!.snapshot().drops).toEqual({});
      expect(spentOf(seasonal!.snapshot())).toBeUndefined();
    }
    // The settled buffer must not leak into the next in-scene loot either: +4 loot is the only credit.
    s.bag(S_LOOT, LOOT, 4);
    expect(sessionDrops(s.e)).toEqual({[LOOT]: 4});
  });

  it('an unrecognised scene [PASS-today]', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, UNKNOWN_SCENE);
    expect(sessionDrops(s.e)).toEqual({});
    expect(spentOf(s.sessionSnap())).toBeUndefined();
  });

  it('a map entered from an unrecognised scene (not town) charges nothing and credits nothing', () => {
    const s = setup();
    s.go(TOWN, UNKNOWN_SCENE);
    spend3(s);                           // buffers: location is 'other'
    s.bag(S_VENDOR, VENDOR, 7);
    s.go(UNKNOWN_SCENE, MAP);

    expect(ctx(s.e).registry.map).not.toBeNull();   // harness precondition: a map did start
    expect(spentOf(s.mapSnap())).toBeUndefined();
    expect(spentOf(s.sessionSnap())).toBeUndefined();
    expect(s.mapSnap()?.drops).toEqual({});
    expect(sessionDrops(s.e)).toEqual({});
    expect(dropEvents(s.events)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('the cost stays on the map across interludes', () => {
  it('map -> Arcana fight -> map: the finished map carries the cost, drops stay clean', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);
    s.line(log.s9Minigame);               // panel opens, map freezes
    s.go(MAP, ARCANA_FIGHT);
    s.bag(S_LOOT, LOOT, 4);               // fight loot +4 -> arcana + session (map frozen)
    s.go(ARCANA_FIGHT, MAP);
    s.go(MAP, TOWN);

    const [map] = finishedOf(s.events, 'map');
    expect(map, 'map tracker_finished').toBeDefined();
    expect(spentOf(map)).toEqual({[MATERIAL]: 3});
    expect(map.drops[MATERIAL]).toBeUndefined();
    expect(spentOf(s.sessionSnap())).toEqual({[MATERIAL]: 3});   // charged once, not per transition
    expect(sessionDrops(s.e)).toEqual({[LOOT]: 4});
  });

  it('map -> Vorex -> town: the finished map carries the cost', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);
    s.line(log.s13Start);
    s.line(log.s13Abandon);
    s.go(MAP, VOREX_REWARD);
    s.go(VOREX_REWARD, TOWN);

    const [map] = finishedOf(s.events, 'map');
    expect(map, 'map tracker_finished').toBeDefined();
    expect(spentOf(map)).toEqual({[MATERIAL]: 3});
    expect(map.drops[MATERIAL]).toBeUndefined();
    expect(sessionDrops(s.e)[MATERIAL]).toBeUndefined();
  });

  it('map -> Sandlord hub -> town: the finished map carries the cost', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);
    s.go(MAP, SANDLORD_HUB);
    s.go(SANDLORD_HUB, TOWN);

    const [map] = finishedOf(s.events, 'map');
    expect(map, 'map tracker_finished').toBeDefined();
    expect(spentOf(map)).toEqual({[MATERIAL]: 3});
    expect(map.drops[MATERIAL]).toBeUndefined();
    expect(sessionDrops(s.e)[MATERIAL]).toBeUndefined();
  });

  it('a town panel live at map entry: the cost goes to the map, not the seasonal', () => {
    const s = setup();
    s.line(log.s9Minigame);               // Arcana panel open in town
    spend3(s);
    s.go(TOWN, MAP);

    const arcana = ctx(s.e).registry.seasonal('arcana');
    expect(arcana, 'arcana must still be live at map entry (harness precondition)').not.toBeNull();
    expect(spentOf(s.mapSnap())).toEqual({[MATERIAL]: 3});
    expect(spentOf(arcana!.snapshot())).toBeUndefined();
    expect(arcana!.snapshot().drops).toEqual({});
    expect(dropsBySource(s.e)).toEqual({});
  });
});

// ---------------------------------------------------------------------------

describe('pause and reset', () => {
  it('paused entry: the buffer is discarded, the map has no cost', () => {
    const s = setup();
    spend3(s);                            // buffered
    s.e.pause();
    s.bag(S_VENDOR, VENDOR, 4);           // while paused: bookkeeping only
    s.go(TOWN, MAP);
    s.e.resume();

    expect(ctx(s.e).registry.map).not.toBeNull();
    expect(spentOf(s.mapSnap())).toBeUndefined();
    expect(spentOf(s.sessionSnap())).toBeUndefined();
    expect(s.mapSnap()?.drops).toEqual({});
    expect(sessionDrops(s.e)).toEqual({});
  });

  it('reset mid-map: the rebuilt map and the new session carry the old map\'s entry cost', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);
    s.bag(S_LOOT, LOOT, 5);
    const before = s.events.length;

    s.e.reset();

    expect(spentOf(s.mapSnap())).toEqual({[MATERIAL]: 3});
    expect(spentOf(s.sessionSnap())).toEqual({[MATERIAL]: 3});
    expect(s.mapSnap()?.drops).toEqual({});          // loot was reset, cost not a negative drop
    expect(sessionDrops(s.e)).toEqual({});
    const after = s.events.slice(before);
    expect(spentOf(lastSnapshot(after, 'map'))).toEqual({[MATERIAL]: 3});
    expect(spentOf(lastSnapshot(after, 'session'))).toEqual({[MATERIAL]: 3});
  });

  it('reset mid-map: a map with no cost carries nothing [PASS-today]', () => {
    const s = setup();
    s.go(TOWN, MAP);
    s.e.reset();
    expect(spentOf(s.mapSnap())).toBeUndefined();
    expect(spentOf(s.sessionSnap())).toBeUndefined();
  });

  it('reset in town after a costed map: the new session has no spent [PASS-today]', () => {
    const s = setup();
    spend3(s);
    s.go(TOWN, MAP);
    s.go(MAP, TOWN);
    s.e.reset();
    expect(spentOf(s.sessionSnap())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('new_item bookkeeping survives the discard', () => {
  it('a first-seen id in the entry buffer still emits new_item, once, at map entry [PASS-today]', () => {
    const s = setup();
    spend3(s);                            // MATERIAL: seeded by bag init, so already known
    s.bag(S_VENDOR, VENDOR, 7);           // VENDOR: first seen (positive, town activity)
    s.go(TOWN, MAP);

    const ids = s.events.flatMap(ev => ev.type === 'new_item' ? [ev.itemId] : []);
    expect(ids).toEqual([VENDOR]);
  });

  it('a first-seen id in a buffer discarded at town -> hub still emits new_item, and credits nothing', () => {
    const s = setup();
    s.bag(S_VENDOR, VENDOR, 7);
    s.go(TOWN, SANDLORD_HUB);

    expect(s.events.filter(ev => ev.type === 'new_item' && ev.itemId === VENDOR)).toHaveLength(1);
    expect(dropsFor(s.events, VENDOR)).toEqual([]);
    expect(sessionDrops(s.e)).toEqual({});
  });
});

// ---------------------------------------------------------------------------

describe('Tracker / TrackerRegistry cost API (unit)', () => {
  type CostTracker = Tracker & {
    addCost(itemId: number, qty: number): void;
    setEntryCost(cost: ReadonlyMap<number, number>): void;
    readonly entryCost: ReadonlyMap<number, number>;
  };
  const tracker = (kind: 'map' | 'session' = 'map') => new Tracker(kind) as CostTracker;

  it('addCost accumulates positive magnitudes into snapshot.spent', () => {
    const t = tracker();
    t.addCost(MATERIAL, 3);
    t.addCost(MATERIAL, 2);
    t.addCost(HIDDEN, 1);
    expect(spentOf(t.snapshot())).toEqual({[MATERIAL]: 5, [HIDDEN]: 1});
    expect(t.snapshot().drops).toEqual({});
  });

  it('snapshot omits spent entirely while empty', () => {
    const t = tracker();
    expect('spent' in t.snapshot()).toBe(false);
  });

  it('cost is structural: a paused tracker still takes it (no active guard)', () => {
    const t = tracker();
    t.pause();
    t.addCost(MATERIAL, 3);
    expect(spentOf(t.snapshot())).toEqual({[MATERIAL]: 3});
  });

  it('setEntryCost replaces the cost, copies its input, and entryCost reads it back', () => {
    const t = tracker();
    t.addCost(HIDDEN, 9);
    const src = new Map([[MATERIAL, 3]]);
    t.setEntryCost(src);
    src.set(MATERIAL, 99);
    expect(spentOf(t.snapshot())).toEqual({[MATERIAL]: 3});
    expect([...t.entryCost]).toEqual([[MATERIAL, 3]]);
  });

  it('registry.chargeEntryCost sets the map cost, adds to the session total, touches no drops', () => {
    const r = new TrackerRegistry() as TrackerRegistry & {chargeEntryCost(c: ReadonlyMap<number, number>): void};
    r.startSession();
    r.startMap();
    r.chargeEntryCost(new Map([[MATERIAL, 3]]));
    expect(spentOf(r.map!.snapshot())).toEqual({[MATERIAL]: 3});
    expect(spentOf(r.session!.snapshot())).toEqual({[MATERIAL]: 3});
    expect(r.map!.snapshot().drops).toEqual({});
    expect(r.session!.snapshot().drops).toEqual({});

    r.map = null;
    r.startMap();
    r.chargeEntryCost(new Map([[MATERIAL, 1]]));
    expect(spentOf(r.map!.snapshot())).toEqual({[MATERIAL]: 1});          // replaced, not summed
    expect(spentOf(r.session!.snapshot())).toEqual({[MATERIAL]: 4});      // 3 + 1
  });
});
