/**
 * 3.1b: Engine.reset while an interlude is in progress. Reset drops the seasonal
 * and rebuilds the map ACTIVE (same openSessionRun path as init); the interlude is
 * still going, so the map must be frozen again and a FRESH seasonal must run, ending
 * through the handler's normal path. The reset run saves nothing; the units that
 * follow are the post-reset ones only.
 *
 * Assumptions where GAMEPLAY.md is silent:
 *  - the fresh seasonal starts at the reset instant (elapsed 0, no drops) and is a child of
 *    the rebuilt map (overlap of the map unit) when one exists, standalone otherwise;
 *  - a reset while the session is paused leaves the seasonal frozen with the session and the map
 *    frozen by the interlude; the session resume wakes only the seasonal (map stays frozen).
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {SeasonalType} from '@/shared/contracts/engine';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, TOWN, VOREX_REWARD, ctx, log,
} from './seasonal-fixtures';
import {LOOT, rig, type Rig} from './interlude-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

interface Case {
  name:   string;
  type:   SeasonalType;
  /** Enter the interlude from a running map (after a map warm-up with loot). */
  open:   (o: Rig) => void;
  /** End it the normal way, back to town. */
  finish: (o: Rig) => void;
  /** Map time the ending adds (a closed panel hands the map back for 10s first). */
  mapMs:  number;
}

const CASES: Case[] = [
  {
    name: 'an Arcana fight', type: 'arcana', mapMs: 0,
    open:   o => { o.line(log.s9Minigame); o.go(MAP, ARCANA_FIGHT); o.adv(5_000); o.drop(2); },
    finish: o => { o.go(ARCANA_FIGHT, TOWN); },
  },
  {
    name: 'an Arcana panel', type: 'arcana', mapMs: 10_000,
    open:   o => { o.line(log.s9Minigame); o.adv(5_000); },
    finish: o => { o.line(log.s9Close); o.adv(10_000); o.go(MAP, TOWN); },
  },
  {
    name: 'a Vorex window', type: 'vorex', mapMs: 10_000,
    open:   o => { o.line(log.s13Start); o.adv(5_000); },
    finish: o => { o.line(log.s13WindowClose); o.adv(10_000); o.go(MAP, TOWN); },
  },
  {
    name: 'a Vorex reward zone', type: 'vorex', mapMs: 0,
    open:   o => {
      o.line(log.s13Start); o.line(log.s13WindowClose); o.line(log.s13Abandon);
      o.go(MAP, VOREX_REWARD); o.adv(5_000); o.drop(2);
    },
    finish: o => { o.go(VOREX_REWARD, TOWN); },
  },
  {
    name: 'a Tartarus board', type: 'tartarus', mapMs: 10_000,
    open:   o => { o.line(log.s16BoardOpen); o.adv(5_000); },
    finish: o => { o.line(log.s16BoardClose); o.adv(10_000); o.go(MAP, TOWN); },
  },
  {
    name: 'the Sandlord hub (from a map)', type: 'sandlord', mapMs: 0,
    open:   o => { o.go(MAP, SANDLORD_HUB); o.adv(5_000); o.drop(2); },
    finish: o => { o.go(SANDLORD_HUB, TOWN); },
  },
];

/** A session already open, a map running with some loot, then the interlude. */
function inInterlude(c: Case) {
  const o = rig();
  o.init();
  o.go(TOWN, MAP);
  o.adv(10_000);
  o.drop(1);
  c.open(o);
  expect(o.seasonal(c.type)).not.toBeNull();     // sanity: the interlude is live before the reset
  return o;
}

describe.each(CASES)('Reset inside $name', (c) => {
  it('the map stays frozen, a fresh run starts, and it ends normally', () => {
    const o = inInterlude(c);
    o.reset();

    // A fresh run (not the one that was torn down), a fresh frozen map, a fresh session.
    const s = o.seasonal(c.type)!;
    expect(s).not.toBeNull();
    expect(s.active).toBe(true);
    expect(s.snapshot().elapsed).toBe(0);
    expect(s.snapshot().drops).toEqual({});
    expect(o.map()).not.toBeNull();
    expect(o.map()?.active).toBe(false);
    expect(o.map()?.elapsed()).toBe(0);
    expect(ctx(o.e).mapPausedForInterludeAt).not.toBeNull();
    expect(ctx(o.e).mapCount).toBe(1);
    expect(ctx(o.e).registry.session?.snapshot().drops).toEqual({});

    o.adv(30_000);                               // the interlude goes on: still no map time
    expect(o.map()?.elapsed()).toBe(0);
    expect(o.seasonal(c.type)?.snapshot().elapsed).toBe(30_000);
    expect(ctx(o.e).accumulatedMapTime).toBe(0);

    c.finish(o);

    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.shape()).toEqual([{primary: 'map', overlaps: [c.type]}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(c.mapMs);
    expect(u.checkpoint.mapTime).toBe(c.mapMs);
    expect(u.checkpoint.mapCount).toBe(1);
    expect(u.overlaps[0].tracker.elapsed).toBe(30_000);
    expect(u.overlaps[0].tracker.drops[LOOT] ?? 0).toBe(0);   // nothing before the reset is carried
    o.assertClean();
  });

  it('loot after the reset goes to the fresh run, not the frozen map', () => {
    const o = inInterlude(c);
    o.reset();
    o.adv(5_000);
    o.drop(4);
    expect(o.seasonal(c.type)?.snapshot().drops[LOOT]).toBe(4);
    expect(o.map()?.snapshot().drops[LOOT] ?? 0).toBe(0);
    expect(ctx(o.e).registry.session?.snapshot().drops[LOOT]).toBe(4);
    c.finish(o);

    const [u] = o.units();
    expect(u.overlaps[0].tracker.drops[LOOT]).toBe(4);
    expect(u.tracker.drops[LOOT] ?? 0).toBe(0);
    o.assertClean();
  });

  it('Reset while PAUSED: everything stays frozen, resume wakes the run but not the map', () => {
    const o = inInterlude(c);
    o.pause();
    o.reset();

    expect(o.seasonal(c.type)).not.toBeNull();
    expect(o.seasonal(c.type)?.active).toBe(false);          // frozen with the session
    expect(o.map()?.active).toBe(false);
    expect(ctx(o.e).mapPausedForInterludeAt).not.toBeNull(); // the interlude owns the map's pause
    o.adv(30_000);
    expect(o.seasonal(c.type)?.snapshot().elapsed).toBe(0);
    expect(o.map()?.elapsed()).toBe(0);

    o.resume();
    expect(o.seasonal(c.type)?.active).toBe(true);
    expect(o.map()?.active).toBe(false);                     // still inside the interlude
    o.adv(20_000);
    expect(o.map()?.elapsed()).toBe(0);
    expect(o.seasonal(c.type)?.snapshot().elapsed).toBe(20_000);
    o.drop(3);
    expect(o.seasonal(c.type)?.snapshot().drops[LOOT]).toBe(3);
    expect(o.map()?.snapshot().drops[LOOT] ?? 0).toBe(0);

    c.finish(o);

    expect(o.shape()).toEqual([{primary: 'map', overlaps: [c.type]}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(c.mapMs);
    expect(u.overlaps[0].tracker.elapsed).toBe(20_000);
    expect(u.overlaps[0].tracker.drops[LOOT]).toBe(3);
    o.assertClean();
  });
});

describe.each([
  {
    name: 'an Arcana panel opened in town', type: 'arcana' as const,
    open:   (o: Rig) => { o.line(log.s9Minigame); o.adv(5_000); },
    finish: (o: Rig) => { o.go(TOWN, ARCANA_FIGHT); o.adv(10_000); o.go(ARCANA_FIGHT, TOWN); },
  },
  {
    name: 'the Sandlord hub entered from town', type: 'sandlord' as const,
    open:   (o: Rig) => { o.go(TOWN, SANDLORD_HUB); o.adv(5_000); },
    finish: (o: Rig) => { o.adv(10_000); o.go(SANDLORD_HUB, TOWN); },
  },
])('Reset inside $name (no map)', (c) => {
  it('a fresh standalone run starts, nothing is frozen, and it ends normally', () => {
    const o = rig();
    o.init();
    c.open(o);
    expect(o.seasonal(c.type)).not.toBeNull();
    o.reset();

    const s = o.seasonal(c.type)!;
    expect(s).not.toBeNull();
    expect(s.active).toBe(true);
    expect(s.snapshot().elapsed).toBe(0);
    expect(s.snapshot().drops).toEqual({});
    expect(o.map()).toBeNull();
    expect(ctx(o.e).inMap).toBe(false);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    expect(ctx(o.e).mapCount).toBe(0);

    c.finish(o);

    expect(o.shape()).toEqual([{primary: c.type, overlaps: []}]);
    expect(o.units()[0].tracker.elapsed).toBe(10_000);
    o.assertClean();
  });
});
