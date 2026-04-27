/**
 * Integration tests: raw log event → Engine → handlers → filter → tracker.
 *
 * These tests run the full engine stack (BagInitHandler + ZoneHandler +
 * DreamHandler + VorexHandler + OverrealmHandler + ItemHandler) and assert
 * that the active ItemFilterEngine correctly controls which drops reach
 * which tracker scopes.
 *
 * The flow under test:
 *   engine.onRawEvent(bag_init / bag_update / zone_transition)
 *     → BagInitHandler    → sets up baselines
 *     → ZoneHandler       → updates ctx.inMap
 *     → DreamHandler      → creates/destroys ctx.seasonal for Dream
 *     → VorexHandler      → creates/destroys ctx.seasonal for Vorex
 *     → OverrealmHandler  → creates/destroys ctx.seasonal for Overrealm
 *     → ItemHandler       → flushes changes, calls ctx.distributeDrop()
 *     → ItemFilterEngine.shouldInclude() → decides per-scope
 *     → Tracker.addDrop()
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Engine}            from '@/main/engine/engine';
import {BagInitHandler}    from '@/main/engine/handlers/bag-init';
import {ZoneHandler}       from '@/main/engine/handlers/zone';
import {DreamHandler}      from '@/main/engine/handlers/dream-handler';
import {VorexHandler}      from '@/main/engine/handlers/vorex-handler';
import {OverrealmHandler}  from '@/main/engine/handlers/overrealm-handler';
import {ItemHandler}       from '@/main/engine/handlers/item';
import {ItemFilterEngine}  from '@/main/engine/item-filter';
import type {EngineEvent}  from '@/main/engine/types';
import type {FilterRule}   from '@/types/itemFilter';
import type {EngineContext} from '@/main/engine/context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOWN_SCENE = 'XZ_YuJinZhiXiBiNanSuo200';
const MAP_SCENE  = '/Game/Art/Maps/S5_Boss';

function createEngine(events: EngineEvent[]): Engine {
  return new Engine((e) => events.push(e))
    .register(new BagInitHandler())
    .register(new ZoneHandler())
    .register(new DreamHandler())
    .register(new VorexHandler())
    .register(new OverrealmHandler())
    .register(new ItemHandler());
}

function makeRule(
  action: FilterRule['action'],
  kind:   FilterRule['kind'],
  scopes: FilterRule['scopes'],
): FilterRule {
  return {id: crypto.randomUUID(), action, kind, scopes};
}

/** Reach into the engine's private context (test-only). */
function ctx(engine: Engine): EngineContext {
  return (engine as unknown as {_ctx: EngineContext})._ctx;
}

/**
 * Boot the engine and complete bag initialisation with a given inventory.
 * Set any filter on the engine AFTER calling boot(), because start() resets the context.
 */
function boot(
  engine:    Engine,
  inventory: Array<{slotId: number; itemId: number; quantity: number}>,
): void {
  engine.start();
  for (const {slotId, itemId, quantity} of inventory) {
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId, itemId, quantity});
  }
  vi.advanceTimersByTime(600); // BagInitHandler debounce
}

function enterMap(engine: Engine): void {
  engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

// ---------------------------------------------------------------------------
// Baseline: no filter — drops go everywhere
// ---------------------------------------------------------------------------

describe('filter-integration — no filter', () => {
  it('all drops reach session and map trackers without a filter', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    boot(engine, [{slotId: 1, itemId: 100, quantity: 10}]);

    enterMap(engine);
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 15});

    expect(ctx(engine).session?.snapshot().drops[100]).toBe(5);
    expect(ctx(engine).map?.snapshot().drops[100]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Filter: hide item in session only
// ---------------------------------------------------------------------------

describe('filter-integration — session scope only', () => {
  it('blocked from session but still counted in map', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [{slotId: 1, itemId: 100, quantity: 10}]);

    const types = new Map([['100', 'equipment' as const]]);
    engine.setFilter(new ItemFilterEngine(
      [makeRule('hide', {type: 'by-item', itemId: '100'}, ['session'])],
      types,
    ));

    enterMap(engine);
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 14});

    expect(ctx(engine).session?.snapshot().drops[100]).toBeUndefined();
    expect(ctx(engine).map?.snapshot().drops[100]).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Filter: hide by type across all scopes
// ---------------------------------------------------------------------------

describe('filter-integration — hide by type, all scopes', () => {
  it('equipment drops are completely ignored, cube drops pass through', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: 100, quantity: 0},
      {slotId: 2, itemId: 200, quantity: 0},
    ]);

    const types = new Map([
      ['100', 'equipment' as const],
      ['200', 'cube'      as const],
    ]);
    engine.setFilter(new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session', 'map', 'vorex', 'dream', 'overrealm', 'wealth'])],
      types,
    ));

    enterMap(engine);
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 3});

    expect(ctx(engine).session?.snapshot().drops[100]).toBeUndefined(); // filtered
    expect(ctx(engine).session?.snapshot().drops[200]).toBe(3);         // passes
  });

  it('drop events to the renderer are gated on the session filter so the dashboard aggregate matches the session tracker', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: 100, quantity: 0},
      {slotId: 2, itemId: 200, quantity: 0},
    ]);

    const types = new Map([
      ['100', 'equipment' as const],
      ['200', 'cube'      as const],
    ]);
    engine.setFilter(new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session', 'map'])],
      types,
    ));

    enterMap(engine);
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 3});

    const dropEvents = events.filter((e): e is Extract<EngineEvent, {type: 'drop'}> => e.type === 'drop');
    expect(dropEvents.map(e => e.itemId)).toEqual([200]);
  });

  it('keeps emitting drop events for filtered map-scope items as long as the session accepts them', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [{slotId: 1, itemId: 100, quantity: 0}]);

    const types = new Map([['100', 'equipment' as const]]);
    engine.setFilter(new ItemFilterEngine(
      // Hide from map only — session still tracks it, so the dashboard
      // aggregate must show the drop.
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['map'])],
      types,
    ));

    enterMap(engine);
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 5});

    const dropEvents = events.filter((e): e is Extract<EngineEvent, {type: 'drop'}> => e.type === 'drop');
    expect(dropEvents).toHaveLength(1);
    expect(dropEvents[0].itemId).toBe(100);
    expect(ctx(engine).session?.snapshot().drops[100]).toBe(5);
    expect(ctx(engine).map?.snapshot().drops[100]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Whitelist pattern through the full stack
// ---------------------------------------------------------------------------

describe('filter-integration — whitelist pattern', () => {
  it('show item 100 first then hide equipment: item 100 tracked, item 200 not', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: 100, quantity: 0},
      {slotId: 2, itemId: 200, quantity: 0},
    ]);

    const types = new Map([
      ['100', 'equipment' as const],
      ['200', 'equipment' as const],
    ]);
    engine.setFilter(new ItemFilterEngine(
      [
        makeRule('show', {type: 'by-item',  itemId:   '100'},       ['session', 'map']),
        makeRule('hide', {type: 'by-type',  itemType: 'equipment'}, ['session', 'map']),
      ],
      types,
    ));

    enterMap(engine);
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 4});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 7});

    expect(ctx(engine).session?.snapshot().drops[100]).toBe(4);         // whitelisted
    expect(ctx(engine).session?.snapshot().drops[200]).toBeUndefined(); // blocked
  });
});

// ---------------------------------------------------------------------------
// Live filter update via engine.updateFilterRules()
// ---------------------------------------------------------------------------

describe('filter-integration — live rule update', () => {
  it('new drops obey updated rules immediately without restarting the engine', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [{slotId: 1, itemId: 100, quantity: 0}]);

    const types = new Map([['100', 'equipment' as const]]);
    engine.setFilter(new ItemFilterEngine([], types));

    enterMap(engine);

    // Drop before filter update — should be tracked
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 3});
    expect(ctx(engine).session?.snapshot().drops[100]).toBe(3);

    // Push a hide rule
    engine.updateFilterRules([
      makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session', 'map']),
    ]);

    // Drop after rule update — accumulator stays at 3, new drop blocked
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 6});
    expect(ctx(engine).session?.snapshot().drops[100]).toBe(3);
  });

  it('passing null to updateFilterRules disables all filtering', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [{slotId: 1, itemId: 100, quantity: 0}]);

    const types = new Map([['100', 'equipment' as const]]);
    engine.setFilter(new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session', 'map'])],
      types,
    ));

    enterMap(engine);

    // Filter active — blocked
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 3});
    expect(ctx(engine).session?.snapshot().drops[100]).toBeUndefined();

    // Disable filter entirely
    engine.updateFilterRules(null);

    // Now passes through
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 6});
    expect(ctx(engine).session?.snapshot().drops[100]).toBe(3); // +3 from qty 3→6
  });
});

// ---------------------------------------------------------------------------
// Town drops (delayed flush) respect the filter
// ---------------------------------------------------------------------------

describe('filter-integration — delayed flush in town', () => {
  it('town drops are still filtered when the buffer flushes after the delay', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [{slotId: 1, itemId: 100, quantity: 0}]);

    const types = new Map([['100', 'equipment' as const]]);
    engine.setFilter(new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    ));

    // Stay in town (no enterMap)
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 5});

    // Not flushed yet
    expect(ctx(engine).session?.snapshot().drops[100]).toBeUndefined();

    vi.advanceTimersByTime(1600);

    // Filter applied at flush time
    expect(ctx(engine).session?.snapshot().drops[100]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dream seasonal scope filtering
// ---------------------------------------------------------------------------

describe('filter-integration — dream seasonal scope', () => {
  it('drops in Dream zone are blocked from dream scope but not session', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [{slotId: 1, itemId: 100, quantity: 0}]);

    const types = new Map([['100', 'equipment' as const]]);
    engine.setFilter(new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['dream'])],
      types,
    ));

    // Enter map then trigger Dream (level_type 3 → 11)
    enterMap(engine);
    engine.onRawEvent({type: 'level_type', levelType: 11});

    expect(ctx(engine).seasonal?.seasonalType).toBe('dream');

    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 5});

    expect(ctx(engine).session?.snapshot().drops[100]).toBe(5);          // session unaffected
    expect(ctx(engine).seasonal?.snapshot().drops[100]).toBeUndefined(); // dream blocked
  });
});
