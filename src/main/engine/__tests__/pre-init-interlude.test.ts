/**
 * Adversarial (2.1) + 3.1b: the bag baseline lands while the player is inside
 * an INTERLUDE (Arcana panel/fight, Vorex window, Sandlord hub) that froze the
 * map. GAMEPLAY.md: the map stays frozen for the whole interlude, and the
 * interlude itself is a live run. The rebuild in openSessionRun starts an
 * ACTIVE map and the handlers saw nothing pre-init — so after init the
 * interlude must be picked up (seasonal started fresh, map re-frozen).
 *
 * More cases (Tartarus, Dream, town-started, ...): pre-init-interlude-more.test.ts.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent, SeasonalType} from '@/shared/contracts/engine';
import {checkCheckpoints, checkUnits} from '@/test/unit-invariant';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, TOWN, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {beginSession, completeInit, unitsWithCheckpoint} from './identity-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const LOOT = 800;
const INV  = [{slotId: 1, itemId: LOOT, quantity: 0}];

function rig() {
  const events: EngineEvent[] = [];
  const e: Engine = createEngine(events);
  const d = createDispatcher();
  beginSession(e);
  let lootTotal = 0;
  return {
    e, d, events,
    go:   (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
    line: (l: string) => feed(d, e, l),
    drop: (n = 1) => { lootTotal += n; feed(d, e, log.bagUpdate(1, LOOT, lootTotal)); },
    adv:  (ms: number) => vi.advanceTimersByTime(ms),
    init: () => completeInit(d, e, INV),
    units: () => unitsWithCheckpoint(events),
  };
}
type Rig = ReturnType<typeof rig>;

/** What the rebuilt map looks like right after init, and after `fightMs` more of the interlude. */
function snapshotMap(o: Rig) {
  const map = ctx(o.e).registry.map;
  return {active: map?.active, elapsed: map?.elapsed(), markerSet: ctx(o.e).mapPausedForInterludeAt !== null};
}

const seasonal = (o: Rig, type: SeasonalType) =>
  ctx(o.e).registry.seasonal(type);

describe('init lands inside an Arcana fight within a map', () => {
  it('the map stays frozen: no time accrues while the fight runs, loot is not credited to it', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(5_000);
    o.init();                                  // baseline lands in the fight
    const atInit = snapshotMap(o);

    // The fight IS the arcana run: it exists and is live right after init.
    expect(seasonal(o, 'arcana')).not.toBeNull();
    expect(seasonal(o, 'arcana')?.active).toBe(true);
    expect(atInit.markerSet).toBe(true);

    o.adv(60_000);                             // the fight goes on
    const afterFight = snapshotMap(o);
    o.drop(2);                                 // fight loot: arcana's, never the frozen map's
    expect(seasonal(o, 'arcana')?.snapshot().drops[LOOT]).toBe(2);
    expect(ctx(o.e).registry.map?.snapshot().drops[LOOT] ?? 0).toBe(0);
    o.go(ARCANA_FIGHT, TOWN);

    const units = o.units();

    // GAMEPLAY.md: a map frozen for an interlude receives no time.
    expect(afterFight.elapsed).toBe(atInit.elapsed);
    expect(afterFight.active).toBe(false);
    for (const u of units) expect(u.checkpoint.mapTime).toBe(0);

    // One map unit; the arcana run (started at init, under the frozen map) rides it as an
    // overlap and holds the fight loot — the map's own loot stays empty.
    expect(units).toHaveLength(1);
    expect(units[0].tracker.kind).toBe('map');
    expect(units[0].tracker.elapsed).toBe(0);
    expect(units[0].tracker.drops[LOOT] ?? 0).toBe(0);
    expect(units[0].overlaps.map(c => c.tracker.seasonalType)).toEqual(['arcana']);
    expect(units[0].overlaps[0].tracker.drops[LOOT]).toBe(2);
    expect(units[0].overlaps[0].tracker.elapsed).toBe(60_000);
    expect(checkUnits(o.events)).toEqual([]);
    expect(checkCheckpoints(o.events)).toEqual([]);
  });

  it('leaving the fight back to the map resumes the map and ends the arcana run', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.init();
    o.adv(20_000);
    o.go(ARCANA_FIGHT, MAP);                   // the player returns to the exact map scene
    expect(seasonal(o, 'arcana')).toBeNull();
    expect(ctx(o.e).registry.map?.active).toBe(true);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(15_000);
    o.drop(1);
    o.go(MAP, TOWN);

    const units = o.units();
    expect(units).toHaveLength(1);
    expect(units[0].tracker.elapsed).toBe(15_000);           // only the post-fight time
    expect(units[0].tracker.drops[LOOT]).toBe(1);
    expect(units[0].checkpoint.mapTime).toBe(15_000);
    expect(units[0].overlaps.map(c => c.tracker.seasonalType)).toEqual(['arcana']);
    expect(units[0].overlaps[0].tracker.elapsed).toBe(20_000);
    expect(checkUnits(o.events)).toEqual([]);
    expect(checkCheckpoints(o.events)).toEqual([]);
  });
});

describe('init lands while the Arcana panel is open on a map', () => {
  it('the map stays frozen until the panel is closed', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.line(log.s9Minigame);
    o.adv(5_000);
    o.init();
    const atInit = snapshotMap(o);
    expect(seasonal(o, 'arcana')).not.toBeNull();
    expect(seasonal(o, 'arcana')?.active).toBe(true);
    expect(atInit.markerSet).toBe(true);
    o.adv(30_000);                              // still in the panel
    const inPanel = snapshotMap(o);
    expect(inPanel.elapsed).toBe(atInit.elapsed);
    expect(inPanel.active).toBe(false);
    expect(seasonal(o, 'arcana')?.snapshot().elapsed).toBe(30_000);

    // Backing out resolves the interlude: the map runs again, the arcana run parks.
    o.line(log.s9Close);
    expect(ctx(o.e).registry.map?.active).toBe(true);
    expect(seasonal(o, 'arcana')?.active).toBe(false);
    o.adv(10_000);
    o.drop(1);                                  // map loot again
    o.go(MAP, TOWN);

    const units = o.units();
    expect(units).toHaveLength(1);
    expect(units[0].tracker.elapsed).toBe(10_000);
    expect(units[0].tracker.drops[LOOT]).toBe(1);
    expect(units[0].checkpoint.mapTime).toBe(10_000);
    expect(units[0].overlaps.map(c => c.tracker.seasonalType)).toEqual(['arcana']);
    expect(units[0].overlaps[0].tracker.elapsed).toBe(30_000);
    expect(units[0].overlaps[0].tracker.drops[LOOT] ?? 0).toBe(0);
    expect(checkUnits(o.events)).toEqual([]);
    expect(checkCheckpoints(o.events)).toEqual([]);
  });
});

describe('init lands while a Vorex window is open on a map', () => {
  it('the map stays frozen until the window closes', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.line(log.s13Start);
    o.adv(5_000);
    o.init();
    const atInit = snapshotMap(o);
    expect(seasonal(o, 'vorex')).not.toBeNull();
    expect(seasonal(o, 'vorex')?.active).toBe(true);
    expect(atInit.markerSet).toBe(true);
    o.adv(30_000);
    const inWindow = snapshotMap(o);
    expect(inWindow.elapsed).toBe(atInit.elapsed);
    expect(inWindow.active).toBe(false);
    expect(seasonal(o, 'vorex')?.snapshot().elapsed).toBe(30_000);

    o.line(log.s13WindowClose);                 // back on the map
    expect(ctx(o.e).registry.map?.active).toBe(true);
    expect(seasonal(o, 'vorex')?.active).toBe(false);
    o.adv(10_000);
    o.go(MAP, TOWN);

    const units = o.units();
    expect(units).toHaveLength(1);
    expect(units[0].tracker.elapsed).toBe(10_000);
    expect(units[0].checkpoint.mapTime).toBe(10_000);
    expect(units[0].overlaps.map(c => c.tracker.seasonalType)).toEqual(['vorex']);
    expect(units[0].overlaps[0].tracker.elapsed).toBe(30_000);
    expect(checkUnits(o.events)).toEqual([]);
    expect(checkCheckpoints(o.events)).toEqual([]);
  });
});

describe('init lands inside the Sandlord hub reached directly from a map', () => {
  it('the map stays frozen for the hub run', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.go(MAP, SANDLORD_HUB);
    o.adv(5_000);
    o.init();
    const atInit = snapshotMap(o);
    expect(seasonal(o, 'sandlord')).not.toBeNull();
    expect(seasonal(o, 'sandlord')?.active).toBe(true);
    expect(seasonal(o, 'sandlord')?.ownsBubble).toBe(true);
    expect(atInit.markerSet).toBe(true);
    o.adv(30_000);
    const inHub = snapshotMap(o);
    o.go(SANDLORD_HUB, TOWN);
    expect(inHub.elapsed).toBe(atInit.elapsed);
    expect(inHub.active).toBe(false);

    // Same shape as the post-init flow: the bubble started under the (frozen) map is its overlap.
    const units = o.units();
    for (const u of units) expect(u.checkpoint.mapTime).toBe(0);
    expect(units).toHaveLength(1);
    expect(units[0].tracker.kind).toBe('map');
    expect(units[0].tracker.elapsed).toBe(0);
    expect(units[0].overlaps.map(c => c.tracker.seasonalType)).toEqual(['sandlord']);
    expect(units[0].overlaps[0].tracker.elapsed).toBe(30_000);
    expect(checkUnits(o.events)).toEqual([]);
    expect(checkCheckpoints(o.events)).toEqual([]);
  });
});
