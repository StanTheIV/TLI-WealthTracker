/**
 * Integration tests: in-map seasonal drop-through.
 *
 * An IN-MAP mechanic (Hunting boss arena, Sandlord coin tile at phase 'map')
 * runs while the map clock keeps going, so its loot must fall through to BOTH
 * the seasonal tracker AND the parent map tracker. The session-detail analytics
 * rely on that containment: with `drop-through` attribution they compute a
 * map's own income as
 *
 *     mapOwnIncome = parentRowIncome - concurrentOverlapIncome
 *
 * If the map row does NOT contain the seasonal's loot, that subtraction goes
 * negative and the UI raises `overlap-exceeds-parent`, clamping map income to
 * zero. These tests pin the containment invariant at the engine boundary so the
 * analytics assumption can't silently drift from what the engine writes.
 *
 * Flow under test:
 *   engine.onRawEvent(bag_init / zone_transition / hunting_* / s10_*)
 *     → BagInitHandler        → baselines
 *     → ZoneHandler           → ctx.inMap, map tracker lifecycle
 *     → HuntingHandler        → 'hunting' seasonal (in-map, drop-through)
 *     → SandlordMapHandler    → 'sandlord' phase 'map' (in-map, drop-through)
 *     → ItemHandler           → flush → registry.distributeDrop()
 *     → Tracker.addDrop() on every live tier
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Engine}             from '@/main/engine/engine';
import {BagInitHandler}     from '@/main/engine/handlers/bag-init';
import {ZoneHandler}        from '@/main/engine/handlers/zone';
import {HuntingHandler}     from '@/main/engine/handlers/hunting-handler';
import {SandlordMapHandler} from '@/main/engine/handlers/sandlord-map-handler';
import {ItemHandler}        from '@/main/engine/handlers/item';
import type {EngineEvent}   from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

const TOWN_SCENE = 'XZ_YuJinZhiXiBiNanSuo200';
const MAP_SCENE  = '/Game/Art/Maps/S5_Boss';

// Stand-ins for the real session's Ecliptic Astrolabes — the drops that went
// missing from the parent map row.
const LOOT_A = 10052;
const LOOT_B = 10054;

function createEngine(events: EngineEvent[]): Engine {
  return new Engine((e) => events.push(e))
    .register(new BagInitHandler())
    .register(new ZoneHandler())
    .register(new HuntingHandler())
    .register(new SandlordMapHandler())
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
  vi.advanceTimersByTime(600); // BagInitHandler debounce
}

const enterMap = (e: Engine) =>
  e.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
const enterTown = (e: Engine) =>
  e.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

/** Bag delta: slot goes from `from` to `to`, producing a drop of (to - from). */
function drop(engine: Engine, slotId: number, itemId: number, to: number): void {
  engine.onRawEvent({type: 'bag_update', pageId: 0, slotId, itemId, quantity: to});
}

/** Start a Hunting run: statue arms, boss-start commits. */
function startHunting(engine: Engine): void {
  engine.onRawEvent({type: 'hunting_statue'});
  engine.onRawEvent({type: 'hunting_boss_start'});
}

const mapDrops = (e: Engine) => ctx(e).registry.map?.snapshot().drops ?? {};
const seasonalDrops = (e: Engine, t: 'hunting' | 'sandlord') =>
  ctx(e).registry.seasonal(t)?.snapshot().drops ?? {};

beforeEach(() => {
  vi.useFakeTimers();
});

// ---------------------------------------------------------------------------
// Hunting — in-map boss arena
// ---------------------------------------------------------------------------

describe('in-map drop-through — Hunting', () => {
  it('credits loot to BOTH the hunting tracker and the parent map tracker', () => {
    const engine = createEngine([]);
    boot(engine, [{slotId: 1, itemId: LOOT_A, quantity: 0}]);

    enterMap(engine);
    startHunting(engine);
    drop(engine, 1, LOOT_A, 2);

    expect(seasonalDrops(engine, 'hunting')[LOOT_A]).toBe(2);
    // The invariant the analytics fold depends on.
    expect(mapDrops(engine)[LOOT_A]).toBe(2);
  });

  it('map row remains a SUPERSET of the hunting row across a whole map', () => {
    const engine = createEngine([]);
    boot(engine, [
      {slotId: 1, itemId: LOOT_A, quantity: 0},
      {slotId: 2, itemId: LOOT_B, quantity: 0},
    ]);

    enterMap(engine);
    drop(engine, 1, LOOT_A, 1);        // plain map loot, before the arena
    startHunting(engine);
    drop(engine, 1, LOOT_A, 3);        // +2 inside the arena
    drop(engine, 2, LOOT_B, 2);        // +2 inside the arena

    const map = mapDrops(engine);
    const hunt = seasonalDrops(engine, 'hunting');

    expect(hunt[LOOT_A]).toBe(2);
    expect(hunt[LOOT_B]).toBe(2);
    expect(map[LOOT_A]).toBe(3);       // 1 plain + 2 dropped through
    expect(map[LOOT_B]).toBe(2);

    // Containment: every item the seasonal recorded is in the map at >= qty.
    for (const [id, qty] of Object.entries(hunt)) {
      expect(map[Number(id)] ?? 0).toBeGreaterThanOrEqual(qty as number);
    }
  });

  it('the analytics fold cannot go negative for a hunting run', () => {
    const engine = createEngine([]);
    boot(engine, [{slotId: 1, itemId: LOOT_B, quantity: 0}]);

    enterMap(engine);
    startHunting(engine);
    drop(engine, 1, LOOT_B, 5);

    // mapOwnIncome = parent - overlap, in raw quantities.
    const net = (mapDrops(engine)[LOOT_B] ?? 0) - (seasonalDrops(engine, 'hunting')[LOOT_B] ?? 0);
    expect(net).toBeGreaterThanOrEqual(0);
  });

  it('loot after the boss dies still drops through while the window is open', () => {
    const engine = createEngine([]);
    boot(engine, [{slotId: 1, itemId: LOOT_A, quantity: 0}]);

    enterMap(engine);
    startHunting(engine);
    engine.onRawEvent({type: 'hunting_boss_end'});
    drop(engine, 1, LOOT_A, 4);        // picked up during the loot window

    expect(seasonalDrops(engine, 'hunting')[LOOT_A]).toBe(4);
    expect(mapDrops(engine)[LOOT_A]).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Sandlord coin tile — the other in-map mechanic (phase 'map')
// ---------------------------------------------------------------------------

describe('in-map drop-through — Sandlord coin tile', () => {
  it('credits loot to BOTH the sandlord tracker and the parent map tracker', () => {
    const engine = createEngine([]);
    boot(engine, [{slotId: 1, itemId: LOOT_A, quantity: 0}]);

    enterMap(engine);
    engine.onRawEvent({type: 's10_wave'});
    drop(engine, 1, LOOT_A, 3);

    const sand = ctx(engine).registry.seasonal('sandlord');
    expect(sand?.snapshot().phase).toBe('map');
    expect(seasonalDrops(engine, 'sandlord')[LOOT_A]).toBe(3);
    expect(mapDrops(engine)[LOOT_A]).toBe(3);
  });

  it('a wave-expiry pause stops crediting the seasonal but the map keeps looting', () => {
    const engine = createEngine([]);
    boot(engine, [{slotId: 1, itemId: LOOT_A, quantity: 0}]);

    enterMap(engine);
    engine.onRawEvent({type: 's10_wave'});
    drop(engine, 1, LOOT_A, 2);

    // Wave window lapses → tracker self-pauses (pauseOnLootExpiry).
    vi.advanceTimersByTime(60_000);
    drop(engine, 1, LOOT_A, 5);        // +3 with the tile dormant

    // The seasonal froze at 2; the map took all 5. Map is still a superset.
    expect(seasonalDrops(engine, 'sandlord')[LOOT_A]).toBe(2);
    expect(mapDrops(engine)[LOOT_A]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Both in-map mechanics at once — the real session's shape
// ---------------------------------------------------------------------------

describe('in-map drop-through — Hunting + Sandlord together', () => {
  it('map contains the SUM of both concurrent seasonals', () => {
    const engine = createEngine([]);
    boot(engine, [{slotId: 1, itemId: LOOT_A, quantity: 0}]);

    enterMap(engine);
    engine.onRawEvent({type: 's10_wave'});
    drop(engine, 1, LOOT_A, 2);        // sandlord owns the write
    startHunting(engine);
    drop(engine, 1, LOOT_A, 6);        // hunting is newest → owns the write

    const map  = mapDrops(engine)[LOOT_A] ?? 0;
    const hunt = seasonalDrops(engine, 'hunting')[LOOT_A] ?? 0;
    const sand = seasonalDrops(engine, 'sandlord')[LOOT_A] ?? 0;

    expect(map).toBe(6);
    // The exact fold the analytics performs — must not go negative.
    expect(map - (hunt + sand)).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: what the stored session actually looks like
// ---------------------------------------------------------------------------

describe('in-map drop-through — persisted row shape', () => {
  it('on town entry the finished map snapshot still contains the seasonal loot', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);
    boot(engine, [{slotId: 1, itemId: LOOT_B, quantity: 0}]);

    enterMap(engine);
    startHunting(engine);
    drop(engine, 1, LOOT_B, 2);
    enterTown(engine);

    const finished = events.filter(e => e.type === 'tracker_finished') as Array<
      Extract<EngineEvent, {type: 'tracker_finished'}>
    >;
    const mapSnap  = finished.find(e => e.tracker.kind === 'map')?.tracker;
    const huntSnap = finished.find(e => e.tracker.seasonalType === 'hunting')?.tracker;

    expect(huntSnap?.drops[LOOT_B]).toBe(2);
    // This is the row that gets persisted as the parent map row.
    expect(mapSnap?.drops[LOOT_B]).toBe(2);
  });
});
