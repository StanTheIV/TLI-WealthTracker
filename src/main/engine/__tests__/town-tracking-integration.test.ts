/**
 * Integration test for town-tracking behavior.
 *
 * Scenario under test:
 *   1. Start engine + complete bag init
 *   2. In town: spend map-creation materials (buffer fills with negatives)
 *   3. Town → map: the buffered spend becomes the new map's entry cost
 *      (snapshot `spent`, positive magnitudes) and adds to the session's
 *      running total — never a negative drop
 *   4. End map (map → town): finishes map tracker; in-map drops counted
 *   5. In town: do various item changes (vendor sell, restock, shuffle)
 *   6. Town → map again: confirm the new map's cost is only the pre-map
 *      material spend, NOT the unrelated town shuffling
 *   7. End map again: assert session drops only contain in-map loot and the
 *      session spent the two material costs — none of the town-only shuffling.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Engine}            from '@/main/engine/engine';
import {BagInitHandler}    from '@/main/engine/handlers/bag-init';
import {SandlordHandler}   from '@/main/engine/handlers/sandlord-handler';
import {ZoneHandler}       from '@/main/engine/handlers/zone';
import {DreamHandler}      from '@/main/engine/handlers/dream-handler';
import {VorexHandler}      from '@/main/engine/handlers/vorex-handler';
import {OverrealmHandler}  from '@/main/engine/handlers/overrealm-handler';
import {LunariaHandler}    from '@/main/engine/handlers/lunaria-handler';
import {ItemHandler}       from '@/main/engine/handlers/item';
import {MapMaterialHandler} from '@/main/engine/handlers/map-material';
import type {EngineEvent}   from '@/shared/contracts/engine';
import type {EngineContext} from '@/main/engine/context';

const TOWN_SCENE = 'XZ_YuJinZhiXiBiNanSuo200';
const MAP_SCENE  = '/Game/Art/Maps/S5_Boss';
/** Matches SANDLORD_HUB_MARKER in sandlord-handler.ts. */
const SANDLORD_HUB_SCENE = '/Game/Art/Maps/YunDuanLvZhou';

const ITEM_MATERIAL = 100; // map-creation material
const ITEM_LOOT     = 200; // generic in-map drop
const ITEM_VENDOR   = 300; // bought in town
const ITEM_JUNK     = 400; // sold in town

function createEngine(events: EngineEvent[]): Engine {
  return new Engine((e) => events.push(e))
    .register(new BagInitHandler())
    .register(new SandlordHandler())
    .register(new ZoneHandler())
    .register(new DreamHandler())
    .register(new VorexHandler())
    .register(new OverrealmHandler())
    .register(new LunariaHandler())
    .register(new ItemHandler())
    .register(new MapMaterialHandler());
}

function ctx(engine: Engine): EngineContext {
  return (engine as unknown as {_ctx: EngineContext})._ctx;
}

const mapSpent     = (engine: Engine) => ctx(engine).registry.map?.snapshot().spent;
const sessionSpent = (engine: Engine) => ctx(engine).registry.session?.snapshot().spent;

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

beforeEach(() => {
  vi.useFakeTimers();
});

describe('town-tracking integration', () => {
  it('town item changes between maps are NOT credited to the session tracker', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_MATERIAL, quantity: 10},
      {slotId: 2, itemId: ITEM_VENDOR,   quantity: 0},
      {slotId: 3, itemId: ITEM_JUNK,     quantity: 5},
      {slotId: 4, itemId: ITEM_LOOT,     quantity: 0},
    ]);

    // ---------------------------------------------------------------------
    // 1. In town: spend map material (10 → 7, i.e. -3) before opening map
    // ---------------------------------------------------------------------
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_MATERIAL, quantity: 7});

    // Buffered, not yet flushed — neither session nor anything sees it
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();

    // ---------------------------------------------------------------------
    // 2. Town → map: the buffered spend is the new map's entry cost and adds
    //    to the session's running cost. It is not loot: no negative drop.
    // ---------------------------------------------------------------------
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});

    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();
    expect(mapSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});
    expect(sessionSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});

    // ---------------------------------------------------------------------
    // 3. In map: pick up loot (ITEM_LOOT 0 → 5)
    // ---------------------------------------------------------------------
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 4, itemId: ITEM_LOOT, quantity: 5});

    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_LOOT]).toBe(5);
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_LOOT]).toBe(5);

    // ---------------------------------------------------------------------
    // 4. Map → town: ends map tracker
    // ---------------------------------------------------------------------
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    expect(ctx(engine).registry.map).toBeNull();

    // Snapshot session state right after the first map ends
    const sessionAfterMap1 = {...(ctx(engine).registry.session?.snapshot().drops ?? {})};

    // ---------------------------------------------------------------------
    // 5. In town: assorted item changes that must NOT touch the session
    //    - sell junk (5 → 0): -5
    //    - buy vendor item (0 → 7): +7
    //    - shuffle: lose then gain ITEM_VENDOR within the buffer (net 0)
    //    - lose more material (7 → 6): -1 (this should attribute to next map)
    // ---------------------------------------------------------------------
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 3, itemId: ITEM_JUNK,   quantity: 0});  // -5
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_VENDOR, quantity: 7});  // +7

    // Let the 1500ms town debounce fire — buffer should flush as `lootContext: false`
    // (no map, no seasonal). Session must NOT pick up these town deltas.
    vi.advanceTimersByTime(1600);

    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_JUNK]).toBeUndefined();
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();

    // No `drop` events should have been emitted for town shuffle either.
    const dropsForJunk   = events.filter(e => e.type === 'drop' && e.itemId === ITEM_JUNK);
    const dropsForVendor = events.filter(e => e.type === 'drop' && e.itemId === ITEM_VENDOR);
    expect(dropsForJunk).toHaveLength(0);
    expect(dropsForVendor).toHaveLength(0);

    // ---------------------------------------------------------------------
    // 6. New map material spend right before next map (7 → 6): -1
    //    This buffers up and becomes the second map's entry cost.
    // ---------------------------------------------------------------------
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_MATERIAL, quantity: 6});

    // Town → map again
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});

    // The new map's cost is this spend alone; the session's is both (3 + 1 = 4).
    expect(mapSpent(engine)).toEqual({[ITEM_MATERIAL]: 1});
    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();
    expect(sessionSpent(engine)).toEqual({[ITEM_MATERIAL]: 4});
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();
    // And the new map tracker should NOT have been polluted by the town junk/vendor activity.
    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_JUNK]).toBeUndefined();
    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();

    // ---------------------------------------------------------------------
    // 7. In second map: pick up more loot (5 → 12): +7
    // ---------------------------------------------------------------------
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 4, itemId: ITEM_LOOT, quantity: 12});

    // End second map
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // ---------------------------------------------------------------------
    // Final session assertions:
    //   drops ITEM_LOOT:     +5 (map1) + +7 (map2) = +12
    //   drops ITEM_MATERIAL: undefined (a cost, not loot)
    //   drops ITEM_JUNK:     undefined (sold in town — not tracked)
    //   drops ITEM_VENDOR:   undefined (bought in town — not tracked)
    //   spent ITEM_MATERIAL: 3 (map1) + 1 (map2) = 4, nothing else
    // ---------------------------------------------------------------------
    const finalSession = ctx(engine).registry.session?.snapshot().drops ?? {};

    expect(finalSession[ITEM_MATERIAL]).toBeUndefined();
    expect(sessionSpent(engine)).toEqual({[ITEM_MATERIAL]: 4});
    expect(finalSession[ITEM_LOOT]).toBe(12);
    expect(finalSession[ITEM_JUNK]).toBeUndefined();
    expect(finalSession[ITEM_VENDOR]).toBeUndefined();

    // Sanity: session went strictly forward between map1-end and map2-end
    // for the loot item — no town activity reverted it.
    expect((sessionAfterMap1[ITEM_LOOT] ?? 0)).toBe(5);
  });

  it('town deltas with no subsequent map entry are discarded after debounce', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_VENDOR, quantity: 10},
    ]);

    // In town only — no map, no seasonal
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_VENDOR, quantity: 3}); // -7

    // Before debounce: no session change yet
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();

    // After debounce: still no session change (lootContext = false at flush)
    vi.advanceTimersByTime(1600);

    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();
    expect(events.some(e => e.type === 'drop')).toBe(false);
  });

  it('AH deposit (single bag remove) → 10s idle → enter map: deduction must NOT be in session OR map', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_VENDOR, quantity: 50}, // the AH item
      {slotId: 2, itemId: ITEM_LOOT,   quantity: 0},
    ]);

    // Sanity: nothing in the session at start (no continued session loaded).
    expect(Object.keys(ctx(engine).registry.session?.snapshot().drops ?? {})).toHaveLength(0);

    // 1. AH deposit: item removed from stash in town.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_VENDOR, quantity: 0}); // -50

    // 2. 10 seconds of idle in town (>>1500ms debounce, so flush happens at ~1.5s
    //    with lootContext=false → discarded).
    vi.advanceTimersByTime(10_000);

    // After the debounce expires, both session and map should be untouched.
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();
    expect(ctx(engine).registry.map).toBeNull();
    expect(events.filter(e => e.type === 'drop' && e.itemId === ITEM_VENDOR)).toHaveLength(0);

    // 3. Enter a map.
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});

    // Map tracker just got created — must NOT have the AH deduction.
    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();
    // Session tracker also clean.
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();

    // 4. Drop something legitimate in the map.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 5});

    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_LOOT]).toBe(5);
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();

    // 5. End the map.
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    const finalSession = ctx(engine).registry.session?.snapshot().drops ?? {};
    expect(finalSession[ITEM_LOOT]).toBe(5);
    expect(finalSession[ITEM_VENDOR]).toBeUndefined();
    expect(Object.keys(finalSession)).toEqual([String(ITEM_LOOT)]);
  });

  it('long town session with rapid changes does NOT accumulate into the next map (timer keeps resetting bug)', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_VENDOR, quantity: 100},
      {slotId: 2, itemId: ITEM_JUNK,   quantity: 100},
      {slotId: 3, itemId: ITEM_LOOT,   quantity: 0},
    ]);

    // Simulate a long town session: a bag change every 500ms for 30 seconds.
    // Each change keeps resetting the 1500ms debounce, so the buffer never
    // flushes in town — but accumulates -1 per tick on ITEM_VENDOR.
    let vendorQty = 100;
    for (let i = 0; i < 60; i++) {
      vendorQty -= 1;
      engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_VENDOR, quantity: vendorQty});
      vi.advanceTimersByTime(500);
    }
    // Final vendorQty = 40, so total town delta = -60.

    // Player enters a map. The accumulated -60 buffer must NOT flush into
    // the map / session — the user has been "settled in town" for 30s.
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 3, itemId: ITEM_LOOT, quantity: 5}); // +5 in map
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    const finalSession = ctx(engine).registry.session?.snapshot().drops ?? {};
    expect(finalSession[ITEM_LOOT]).toBe(5);
    expect(finalSession[ITEM_VENDOR]).toBeUndefined(); // 30 seconds of town shopping must not leak
  });

  it('discarded town deltas (debounced before map entry) do NOT bleed into the session — neither negatives nor positives', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_MATERIAL, quantity: 10},
      {slotId: 2, itemId: ITEM_VENDOR,   quantity: 0},
      {slotId: 3, itemId: ITEM_JUNK,     quantity: 5},
      {slotId: 4, itemId: ITEM_LOOT,     quantity: 0},
    ]);

    // -------------------------------------------------------------------
    // Map 1: open, drop loot, close. Establish a clean baseline.
    // -------------------------------------------------------------------
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 4, itemId: ITEM_LOOT, quantity: 5}); // +5
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // Snapshot session state — only ITEM_LOOT +5 should be present.
    const sessionAfterMap1 = {...(ctx(engine).registry.session?.snapshot().drops ?? {})};
    expect(sessionAfterMap1[ITEM_LOOT]).toBe(5);
    expect(Object.keys(sessionAfterMap1)).toEqual([String(ITEM_LOOT)]);

    // -------------------------------------------------------------------
    // In town: do a mix of negatives AND positives
    //   - sell junk (5 → 0): -5
    //   - buy vendor item (0 → 7): +7
    //   - lose more junk somehow (already 0, simulate restock then loss)
    //     to exercise both signs
    // Then let the 1500ms debounce EXPIRE so the buffer flushes as
    // `lootContext: false` (and is discarded).
    // -------------------------------------------------------------------
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 3, itemId: ITEM_JUNK,   quantity: 0}); // -5
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_VENDOR, quantity: 7}); // +7

    // CRITICAL: let the debounce expire so the buffer is flushed in town
    // (lootContext=false at flush time) and discarded.
    vi.advanceTimersByTime(1600);

    // Even more town shuffling AFTER the discard, also debounced and discarded.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_VENDOR, quantity: 2}); // -5
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 3, itemId: ITEM_JUNK,   quantity: 3}); // +3
    vi.advanceTimersByTime(1600);

    // -------------------------------------------------------------------
    // Map 2: open WITHOUT any item changes in the immediate-pre-map
    // buffer (it has been discarded already). Drop more loot.
    // -------------------------------------------------------------------
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 4, itemId: ITEM_LOOT, quantity: 12}); // +7
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // -------------------------------------------------------------------
    // Final session assertions — town shuffle MUST NOT have leaked.
    // Expected: ITEM_LOOT = +5 (map1) + +7 (map2) = +12, nothing else.
    // -------------------------------------------------------------------
    const finalSession = ctx(engine).registry.session?.snapshot().drops ?? {};

    expect(finalSession[ITEM_LOOT]).toBe(12);
    expect(finalSession[ITEM_JUNK]).toBeUndefined();
    expect(finalSession[ITEM_VENDOR]).toBeUndefined();
    expect(finalSession[ITEM_MATERIAL]).toBeUndefined();
    expect(Object.keys(finalSession)).toEqual([String(ITEM_LOOT)]);

    // No `drop` events should have been emitted for any town shuffle item.
    const townItemDrops = events.filter(e =>
      e.type === 'drop' && (e.itemId === ITEM_JUNK || e.itemId === ITEM_VENDOR),
    );
    expect(townItemDrops).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Per-map persistence path — these tests catch the bugs where the chart's
  // cost/income math went wrong because the wrong data flowed into m.spent
  // and m.drops. The map snapshot at map-end carries both (`spent` and
  // `drops`) — what SessionPersistence writes to the DB columns.
  // ---------------------------------------------------------------------------

  it('AH listing in town (single bag remove, then 10s idle, then map): m.spent and m.drops are both clean', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_VENDOR, quantity: 50}, // a valuable item that gets AH-listed
      {slotId: 2, itemId: ITEM_LOOT,   quantity: 0},
    ]);

    // 1. AH listing — single big inventory removal.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_VENDOR, quantity: 0}); // -50

    // 2. Idle in town for 10 seconds — way past the 1500ms debounce.
    vi.advanceTimersByTime(10_000);

    // 3. Open a map.
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});

    // CRITICAL: the map's cost must NOT contain the AH listing. This is what
    // writes the per-map "spent" DB column that drives the chart's cost line.
    expect(mapSpent(engine)).toBeUndefined();
    expect(sessionSpent(engine)).toBeUndefined();

    // 4. Drop something legit in the map.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 5});

    // 5. End map. m.drops snapshot is the map tracker's drops.
    const mapSnapshot = ctx(engine).registry.map?.snapshot();
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // m.drops only has loot. m.spent is empty. No AH leak anywhere.
    expect(mapSnapshot?.drops).toEqual({[ITEM_LOOT]: 5});
    expect(mapSnapshot?.drops[ITEM_VENDOR]).toBeUndefined();

    // Session also clean.
    const session = ctx(engine).registry.session?.snapshot().drops ?? {};
    expect(session[ITEM_LOOT]).toBe(5);
    expect(session[ITEM_VENDOR]).toBeUndefined();
  });

  it('legitimate map-creation spend just before map: lands in m.spent only, never in m.drops', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_MATERIAL, quantity: 10},
      {slotId: 2, itemId: ITEM_LOOT,     quantity: 0},
    ]);

    // Spend material in town (-3) right before opening map.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_MATERIAL, quantity: 7});
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});

    // m.spent has the material as a positive quantity — the map's entry cost.
    expect(mapSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});

    // It is not loot: neither the map nor the session books a negative drop.
    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();

    // The session carries it as its running cost (a real session-level deduction).
    expect(sessionSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});

    // In-map loot.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_LOOT, quantity: 5});
    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_LOOT]).toBe(5);

    // End the map and verify the snapshot that would write to DB.
    const mapAtExit = ctx(engine).registry.map?.snapshot();
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // m.drops carries the loot only; m.spent the cost.
    expect(mapAtExit?.drops).toEqual({[ITEM_LOOT]: 5});
    expect(mapAtExit?.spent).toEqual({[ITEM_MATERIAL]: 3});
  });

  it('a second map entered with nothing bought records no spend (no stale basket)', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_MATERIAL, quantity: 10},
      {slotId: 2, itemId: ITEM_LOOT,     quantity: 0},
    ]);

    // Map 1 consumes 3 material.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_MATERIAL, quantity: 7});
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    expect(mapSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // Straight back into a map having bought nothing. The new map has no cost —
    // inheriting map 1's basket would book the same materials on both rows.
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    expect(mapSpent(engine)).toBeUndefined();
    expect(sessionSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});
  });

  it('a town-started seasonal records no spend from the preceding map', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_MATERIAL, quantity: 10},
      {slotId: 2, itemId: ITEM_LOOT,     quantity: 0},
    ]);

    // A map consumes 3 material, then ends.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_MATERIAL, quantity: 7});
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // Town -> Sandlord hub with an empty bag buffer. The hub run consumed
    // nothing, so booking the map's basket against it would double-count.
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: SANDLORD_HUB_SCENE});
    expect(ctx(engine).registry.seasonal('sandlord')).not.toBeNull();
    expect(ctx(engine).registry.seasonal('sandlord')?.snapshot().spent).toBeUndefined();
    expect(sessionSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});
  });

  it('mixed town activity: AH listing earlier + map material right before map → only the material attributes', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_VENDOR,   quantity: 50},   // valuable AH item
      {slotId: 2, itemId: ITEM_MATERIAL, quantity: 10},   // map material
      {slotId: 3, itemId: ITEM_LOOT,     quantity: 0},
    ]);

    // 1. AH listing at t=0.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_VENDOR, quantity: 0}); // -50
    // 2. Wait long enough for the buffer to flush in town and discard.
    vi.advanceTimersByTime(2_000);
    // 3. At t=2s, spend map material.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_MATERIAL, quantity: 7}); // -3
    // 4. Immediately open the map (within 1500ms of the material spend).
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});

    // m.spent contains ONLY the material — AH listing was discarded earlier.
    expect(mapSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});

    // m.drops (map tracker) has neither the cost nor the AH listing.
    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();
    expect(ctx(engine).registry.map?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();

    // Session cost is only the material (AH discarded, never reached session).
    expect(sessionSpent(engine)).toEqual({[ITEM_MATERIAL]: 3});
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_MATERIAL]).toBeUndefined();
    expect(ctx(engine).registry.session?.snapshot().drops[ITEM_VENDOR]).toBeUndefined();
  });

  it('chart sanity: per-map loot and cost (m.drops, m.spent) reproduce the session exactly', () => {
    // Per-map rows and the session carry the same two disjoint records:
    //   loot = drops, cost = spent, net = loot − cost
    // Aggregated across all maps, both MUST equal the session's (same number
    // as TOTAL FE on the dashboard). The earlier -13.5k chart vs +3.2k TOTAL
    // FE bug was a violation of this invariant.
    const events: EngineEvent[] = [];
    const engine = createEngine(events);

    boot(engine, [
      {slotId: 1, itemId: ITEM_MATERIAL, quantity: 100},
      {slotId: 2, itemId: ITEM_VENDOR,   quantity: 50},
      {slotId: 3, itemId: ITEM_LOOT,     quantity: 0},
    ]);

    type MapRow = {drops: Record<number, number>; spent: Record<number, number>};
    const mapRows: MapRow[] = [];

    const captureMapEnd = () => {
      const snap = ctx(engine).registry.map?.snapshot();
      if (snap) mapRows.push({drops: snap.drops, spent: snap.spent ?? {}});
    };

    // Map 1: spend 5 material, loot +10, no AH.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_MATERIAL, quantity: 95}); // -5
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 3, itemId: ITEM_LOOT, quantity: 10});
    captureMapEnd();
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // In town: AH list 30 vendor items (-30). Idle past debounce.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: ITEM_VENDOR, quantity: 20}); // -30
    vi.advanceTimersByTime(2_000);

    // Map 2: spend 3 material, loot +7.
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: ITEM_MATERIAL, quantity: 92}); // -3
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 3, itemId: ITEM_LOOT, quantity: 17}); // +7
    captureMapEnd();
    engine.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    // Per-item sums across the rows, loot and cost separately.
    const sum = (pick: (r: MapRow) => Record<number, number>) => {
      const out: Record<number, number> = {};
      for (const row of mapRows) {
        for (const [id, qty] of Object.entries(pick(row))) out[Number(id)] = (out[Number(id)] ?? 0) + qty;
      }
      return out;
    };
    const rowLoot = sum(r => r.drops);
    const rowCost = sum(r => r.spent);

    const snap = ctx(engine).registry.session!.snapshot();
    // Loot and cost each sum to the session's, so their difference (net) does too.
    expect(rowLoot).toEqual(snap.drops);
    expect(rowCost).toEqual(snap.spent);

    // Concrete sanity: the AH listing is in NEITHER side. It evaporated in town.
    expect(snap.drops[ITEM_VENDOR]).toBeUndefined();
    expect(snap.spent?.[ITEM_VENDOR]).toBeUndefined();

    // Material cost 5 + 3 = 8, loot +17 — across both maps; net material -8.
    expect(snap.spent).toEqual({[ITEM_MATERIAL]: 8});
    expect(snap.drops).toEqual({[ITEM_LOOT]: 17});
    expect((rowLoot[ITEM_MATERIAL] ?? 0) - (rowCost[ITEM_MATERIAL] ?? 0)).toBe(-8);
  });
});
