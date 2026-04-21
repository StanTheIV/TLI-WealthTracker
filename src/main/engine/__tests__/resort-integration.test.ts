/**
 * Integration tests: init → drops → resort → drops.
 *
 * Exercises the full handler chain through a realistic farming-session
 * flow where the player picks up items, the game bulk-emits InitBagData
 * as an inventory resort, and the player keeps picking up items after.
 *
 * Assertions verify that:
 *   - Drops before the resort are tracked correctly
 *   - A pure resort (totals conserved, slots shuffled) emits zero drops
 *   - Drops after the resort continue to be tracked correctly
 *   - No phantom positive/negative deltas surface from slot-level churn
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Engine}           from '@/main/engine/engine';
import {BagInitHandler}   from '@/main/engine/handlers/bag-init';
import {ZoneHandler}      from '@/main/engine/handlers/zone';
import {ItemHandler}      from '@/main/engine/handlers/item';
import type {EngineEvent} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const TOWN_SCENE = 'XZ_YuJinZhiXiBiNanSuo200';
const MAP_SCENE  = '/Game/Art/Maps/S5_Boss';

function createEngine(events: EngineEvent[]): Engine {
  return new Engine((e) => events.push(e))
    .register(new BagInitHandler())
    .register(new ZoneHandler())
    .register(new ItemHandler());
}

function ctx(engine: Engine): EngineContext {
  return (engine as unknown as {_ctx: EngineContext})._ctx;
}

function boot(
  engine:    Engine,
  inventory: Array<{slotId: number; itemId: number; quantity: number}>,
): void {
  engine.start();
  for (const {slotId, itemId, quantity} of inventory) {
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId, itemId, quantity});
  }
  vi.advanceTimersByTime(600); // BagInitHandler init debounce
}

function enterMap(engine: Engine): void {
  engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
}

function emitResort(
  engine:  Engine,
  layout:  Array<{slotId: number; itemId: number; quantity: number}>,
): void {
  for (const {slotId, itemId, quantity} of layout) {
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId, itemId, quantity});
  }
  vi.advanceTimersByTime(400); // Resort debounce (300ms) + buffer
}

function dropEvents(events: EngineEvent[]): Array<{itemId: number; change: number}> {
  return events
    .filter((e): e is Extract<EngineEvent, {type: 'drop'}> => e.type === 'drop')
    .map(e => ({itemId: e.itemId, change: e.change}));
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('resort-integration — init → drops → resort → drops', () => {
  it('tracks drops correctly through a resort that reshuffles a new stack', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    // Initial inventory: item 100 qty 5 in slot 1, item 200 qty 3 in slot 2
    boot(engine, [
      {slotId: 1, itemId: 100, quantity: 5},
      {slotId: 2, itemId: 200, quantity: 3},
    ]);

    enterMap(engine);

    // --- Phase 1: drops before the resort ---
    // Pick up 5 more of item 100 (stack in slot 1 grows to 10)
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 10});

    // Pick up item 300 qty 1 — a brand new stack in slot 3
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 3, itemId: 300, quantity: 1});

    // Pick up more of item 300 (stack grows to 4)
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 3, itemId: 300, quantity: 4});

    // Sanity check before resort
    expect(ctx(engine).session?.snapshot().drops).toEqual({100: 5, 300: 4});
    expect(ctx(engine).map?.snapshot().drops).toEqual({100: 5, 300: 4});
    expect(dropEvents(events)).toEqual([
      {itemId: 100, change: 5},
      {itemId: 300, change: 1},
      {itemId: 300, change: 3},
    ]);

    // --- Phase 2: resort — same items, different slot layout ---
    // Game bulk-emits InitBagData sorting items numerically
    const dropsBeforeResort = dropEvents(events).length;
    emitResort(engine, [
      {slotId: 10, itemId: 100, quantity: 10},
      {slotId: 11, itemId: 200, quantity: 3},
      {slotId: 12, itemId: 300, quantity: 4},
    ]);

    // Resort was conservative — no drops emitted
    expect(dropEvents(events).length).toBe(dropsBeforeResort);
    expect(ctx(engine).bag.getTotalForItem(100)).toBe(10);
    expect(ctx(engine).bag.getTotalForItem(200)).toBe(3);
    expect(ctx(engine).bag.getTotalForItem(300)).toBe(4);

    // Tracker drops unchanged by the resort
    expect(ctx(engine).session?.snapshot().drops).toEqual({100: 5, 300: 4});

    // --- Phase 3: drops after the resort ---
    // Pick up 2 more of item 100 at its new slot 10 (10 → 12)
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 10, itemId: 100, quantity: 12});

    // Pick up 3 more of item 300 at its new slot 12 (4 → 7)
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 12, itemId: 300, quantity: 7});

    // Pick up a brand-new item 400 at slot 20
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 20, itemId: 400, quantity: 1});

    // All post-resort drops tracked correctly
    expect(ctx(engine).session?.snapshot().drops).toEqual({
      100: 7,   // 5 (pre-resort) + 2 (post-resort)
      300: 7,   // 4 (pre-resort) + 3 (post-resort)
      400: 1,   // fresh
    });
    expect(ctx(engine).map?.snapshot().drops).toEqual({
      100: 7,
      300: 7,
      400: 1,
    });

    // The drop event stream shows exactly the picks, no phantom entries
    expect(dropEvents(events)).toEqual([
      {itemId: 100, change: 5},
      {itemId: 300, change: 1},
      {itemId: 300, change: 3},
      {itemId: 100, change: 2},
      {itemId: 300, change: 3},
      {itemId: 400, change: 1},
    ]);
  });

  it('resort that consolidates stacks (merge) emits no phantom drops', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: 100, quantity: 3},
      {slotId: 2, itemId: 100, quantity: 5}, // split stack
    ]);
    enterMap(engine);

    // Resort consolidates the two stacks of item 100 into one slot
    emitResort(engine, [
      {slotId: 7, itemId: 100, quantity: 8}, // 3 + 5, now merged
    ]);

    expect(dropEvents(events)).toEqual([]);
    expect(ctx(engine).bag.getTotalForItem(100)).toBe(8);
    expect(ctx(engine).session?.snapshot().drops).toEqual({});
  });

  it('stack overflow pickup: 950 + 100 → 999 + 51, then resort moves the overflow', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    // Initial layout:
    //   slot 0 = item 100 × 950 (large stack)
    //   slot 1 = item 200 × 1   (random other item)
    boot(engine, [
      {slotId: 0, itemId: 100, quantity: 950},
      {slotId: 1, itemId: 200, quantity: 1},
    ]);

    enterMap(engine);

    // --- Phase 1: overflow pickup ---
    // Player picks up 100 of item 100. Game splits this across stacks:
    //   - existing slot 0 grows from 950 → 999
    //   - new slot 2 is created with the overflow: 51
    // Net: +49 + +51 = +100 for item 100
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 0, itemId: 100, quantity: 999});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: 100, quantity: 51});

    expect(ctx(engine).bag.getTotalForItem(100)).toBe(1050);
    expect(ctx(engine).session?.snapshot().drops).toEqual({100: 100});
    expect(dropEvents(events)).toEqual([
      {itemId: 100, change: 49},
      {itemId: 100, change: 51},
    ]);

    // --- Phase 2: resort swaps the overflow stack with the random item ---
    // After resort, layout by x-axis:
    //   slot 0 = item 100 × 999 (large stack, unchanged position)
    //   slot 1 = item 100 × 51  (overflow moved from slot 2 → 1)
    //   slot 2 = item 200 × 1   (random item moved from slot 1 → 2)
    const dropsBeforeResort = dropEvents(events).length;
    emitResort(engine, [
      {slotId: 0, itemId: 100, quantity: 999},
      {slotId: 1, itemId: 100, quantity: 51},
      {slotId: 2, itemId: 200, quantity: 1},
    ]);

    // Totals conserved → no drops emitted by the resort
    expect(dropEvents(events).length).toBe(dropsBeforeResort);
    expect(ctx(engine).bag.getTotalForItem(100)).toBe(1050);
    expect(ctx(engine).bag.getTotalForItem(200)).toBe(1);
    expect(ctx(engine).session?.snapshot().drops).toEqual({100: 100});

    // --- Phase 3: more pickups at the new slot layout ---
    // Pick up 10 more of item 100 — fills into overflow at new slot 1 (51 → 61)
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 61});

    // Pick up a fresh brand-new item at slot 5
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 5, itemId: 300, quantity: 1});

    // Pick up enough of item 100 to overflow into ANOTHER stack:
    //   slot 0 grows 999 → 999 (unchanged — already full)
    //   wait: more realistic is slot 1 grows 61 → 999 and slot 5 pushes out → let's pick
    //   a simpler follow-up: stack at slot 1 grows to 100
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 100});

    expect(ctx(engine).bag.getTotalForItem(100)).toBe(1099);
    expect(ctx(engine).session?.snapshot().drops).toEqual({
      100: 149, // original 100 + 10 + 39
      300: 1,
    });
    expect(ctx(engine).map?.snapshot().drops).toEqual({
      100: 149,
      300: 1,
    });

    // Complete event stream: only real pickups, no phantoms from the resort
    expect(dropEvents(events)).toEqual([
      {itemId: 100, change: 49},
      {itemId: 100, change: 51},
      {itemId: 100, change: 10},
      {itemId: 300, change: 1},
      {itemId: 100, change: 39},
    ]);
  });

  it('resort bundled with a genuine item change emits only the real delta', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: 100, quantity: 10},
      {slotId: 2, itemId: 200, quantity: 5},
    ]);
    enterMap(engine);

    // Server reconciliation: item 100 went from 10 to 12 (someone traded in,
    // or stash pull) — but came through as a full InitBagData burst.
    emitResort(engine, [
      {slotId: 5, itemId: 100, quantity: 12},
      {slotId: 6, itemId: 200, quantity: 5},
    ]);

    const drops = dropEvents(events);
    expect(drops).toEqual([{itemId: 100, change: 2}]);
    expect(ctx(engine).session?.snapshot().drops).toEqual({100: 2});
  });
});
