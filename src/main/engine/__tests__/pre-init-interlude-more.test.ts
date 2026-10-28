/**
 * 3.1b: the bag baseline lands while an interlude (or Dream) is in progress.
 * Every scenario runs twice through the same `play(pre)` script:
 *   - "pre-init": the script plays while the engine is `initializing`, then the baseline lands;
 *   - "control": the baseline lands first and the script replays after it (waits skipped).
 * The control is the ordinary post-init flow, so it passes today and pins the expectation;
 * the pre-init run must end in the identical state. Each run ends the interlude normally
 * and checks the unit stream (checkUnits / checkCheckpoints / OwnerWatcher).
 *
 * Assumptions where GAMEPLAY.md is silent:
 *  - a seasonal started at init is a child of the rebuilt map (overlap of the map unit), like any
 *    seasonal started under a frozen map; with no map it is a standalone unit;
 *  - only time and loot from init on belong to the run (the map is rebuilt fresh, so is the seasonal).
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TARTARUS_FIGHT, TOWN, VOREX_REWARD, ctx, log,
} from './seasonal-fixtures';
import {LOOT, rig, type Rig} from './interlude-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const MODES = [['pre-init', false], ['control (same script after init)', true]] as const;

/** Tartarus: Suppress on the Riot screen with the sibling lines the game logs. */
function suppress(o: Rig): void {
  o.line(log.s16SuppressRow);
  o.line(log.s16Suppress);
  o.line(log.s16BoardClose);
  o.line(log.s16BoardCloseTip);
}

/** The shared post-init expectations of a seasonal interlude frozen over a map. */
function expectFrozenOver(o: Rig, type: Parameters<Rig['seasonal']>[0]): void {
  expect(o.seasonal(type)).not.toBeNull();
  expect(o.seasonal(type)?.active).toBe(true);
  expect(o.map()).not.toBeNull();
  expect(o.map()?.active).toBe(false);
  expect(ctx(o.e).mapPausedForInterludeAt).not.toBeNull();
  expect(o.map()?.elapsed()).toBe(0);
  expect(ctx(o.e).inMap).toBe(true);
  expect(ctx(o.e).mapCount).toBe(1);
}

describe.each(MODES)('Tartarus at session open (%s)', (_label, control) => {
  it('board open on a map: map frozen, Esc resumes it, the run is an overlap', () => {
    const o = rig({control});
    o.play(() => {
      o.go(TOWN, MAP);
      o.adv(10_000);
      o.line(log.s16BoardOpen);
      o.adv(5_000);
    });
    expectFrozenOver(o, 'tartarus');
    o.adv(30_000);
    expect(o.map()?.elapsed()).toBe(0);
    expect(o.seasonal('tartarus')?.snapshot().elapsed).toBe(30_000);

    o.line(log.s16BoardClose);                 // Esc: the player is back on the map
    expect(o.map()?.active).toBe(true);
    expect(o.seasonal('tartarus')?.active).toBe(false);
    o.adv(10_000);
    o.drop(1);                                 // map loot again
    o.go(MAP, TOWN);

    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['tartarus']}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(10_000);
    expect(u.tracker.drops[LOOT]).toBe(1);
    expect(u.checkpoint.mapTime).toBe(10_000);
    expect(u.overlaps[0].tracker.elapsed).toBe(30_000);
    expect(u.overlaps[0].tracker.drops[LOOT] ?? 0).toBe(0);
    o.assertClean();
  });

  it('prison fight on a map: the fight loot is the run\'s, the map gets no time', () => {
    const o = rig({control});
    o.play(() => {
      o.go(TOWN, MAP);
      o.adv(10_000);
      o.line(log.s16BoardOpen);
      o.adv(5_000);
      suppress(o);
      o.go(MAP, TARTARUS_FIGHT);
      o.adv(5_000);
    });
    expectFrozenOver(o, 'tartarus');
    o.adv(20_000);
    o.drop(3);
    expect(o.seasonal('tartarus')?.snapshot().drops[LOOT]).toBe(3);
    expect(o.map()?.snapshot().drops[LOOT] ?? 0).toBe(0);
    o.go(TARTARUS_FIGHT, TOWN);

    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['tartarus']}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(0);
    expect(u.tracker.drops[LOOT] ?? 0).toBe(0);
    expect(u.checkpoint.mapTime).toBe(0);
    expect(u.overlaps[0].tracker.elapsed).toBe(20_000);
    expect(u.overlaps[0].tracker.drops[LOOT]).toBe(3);
    o.assertClean();
  });

  it('committed (Suppress) before the prison loads: the interlude is already on, the prison continues the run', () => {
    const o = rig({control});
    o.play(() => {
      o.go(TOWN, MAP);
      o.adv(10_000);
      o.line(log.s16BoardOpen);
      o.adv(5_000);
      suppress(o);                              // board closed, still on the map scene
      o.adv(1_000);
    });
    expectFrozenOver(o, 'tartarus');
    o.adv(4_000);                               // loading
    o.go(MAP, TARTARUS_FIGHT);
    expect(o.seasonal('tartarus')?.active).toBe(true);
    o.adv(20_000);
    o.drop(2);
    o.go(TARTARUS_FIGHT, TOWN);

    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['tartarus']}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(0);
    expect(u.tracker.drops[LOOT] ?? 0).toBe(0);
    expect(u.overlaps[0].tracker.elapsed).toBe(24_000);
    expect(u.overlaps[0].tracker.drops[LOOT]).toBe(2);
    o.assertClean();
  });

  it('board open in town (no map): a standalone run, nothing to freeze', () => {
    const o = rig({control});
    o.play(() => {
      o.line(log.s16BoardOpen);
      o.adv(5_000);
    });
    expect(o.seasonal('tartarus')?.active).toBe(true);
    expect(o.map()).toBeNull();
    expect(ctx(o.e).inMap).toBe(false);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(10_000);
    suppress(o);
    o.go(TOWN, TARTARUS_FIGHT);
    o.adv(20_000);
    o.drop(2);
    o.go(TARTARUS_FIGHT, TOWN);

    expect(o.shape()).toEqual([{primary: 'tartarus', overlaps: []}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(30_000);
    expect(u.tracker.drops[LOOT]).toBe(2);
    expect(ctx(o.e).mapCount).toBe(0);
    o.assertClean();
  });
});

describe.each(MODES)('Dream at session open (%s)', (_label, control) => {
  it('level_type 11 seen before init: the dream run starts at init and credits dream AND the live map', () => {
    const o = rig({control});
    o.play(() => {
      o.go(TOWN, MAP);
      o.adv(10_000);
      o.line(log.levelType(11));
      o.adv(5_000);
    });
    expect(o.seasonal('dream')?.active).toBe(true);
    expect(o.map()?.active).toBe(true);          // dream is in-map: nothing freezes
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(20_000);
    o.drop(2);
    expect(o.seasonal('dream')?.snapshot().drops[LOOT]).toBe(2);
    expect(o.map()?.snapshot().drops[LOOT]).toBe(2);
    o.line(log.levelType(3));                    // out of the dream: its run ends normally
    expect(o.seasonal('dream')).toBeNull();
    o.adv(10_000);
    o.go(MAP, TOWN);

    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['dream']}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(30_000);
    expect(u.checkpoint.mapTime).toBe(30_000);
    expect(u.overlaps[0].tracker.elapsed).toBe(20_000);
    expect(u.overlaps[0].tracker.drops[LOOT]).toBe(2);
    o.assertClean();
  });
});

describe.each(MODES)('town-started panels at session open (%s)', (_label, control) => {
  it('Arcana panel opened in town: the run starts, nothing is frozen, no map', () => {
    const o = rig({control});
    o.play(() => {
      o.line(log.s9Minigame);
      o.adv(5_000);
    });
    expect(o.seasonal('arcana')?.active).toBe(true);
    expect(o.map()).toBeNull();
    expect(ctx(o.e).inMap).toBe(false);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(10_000);
    o.go(TOWN, ARCANA_FIGHT);
    o.adv(20_000);
    o.drop(2);
    o.go(ARCANA_FIGHT, TOWN);

    expect(o.shape()).toEqual([{primary: 'arcana', overlaps: []}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(30_000);
    expect(u.tracker.drops[LOOT]).toBe(2);
    expect(ctx(o.e).mapCount).toBe(0);
    o.assertClean();
  });

  it('Vorex window opened in town: the run starts, nothing is frozen, no map', () => {
    const o = rig({control});
    o.play(() => {
      o.line(log.s13Start);
      o.adv(5_000);
    });
    expect(o.seasonal('vorex')?.active).toBe(true);
    expect(o.map()).toBeNull();
    expect(ctx(o.e).inMap).toBe(false);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(10_000);
    o.line(log.s13WindowClose);
    o.line(log.s13Abandon);
    o.go(TOWN, VOREX_REWARD);
    o.adv(20_000);
    o.drop(2);
    o.go(VOREX_REWARD, TOWN);

    expect(o.shape()).toEqual([{primary: 'vorex', overlaps: []}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(30_000);
    expect(u.tracker.drops[LOOT]).toBe(2);
    o.assertClean();
  });
});

describe.each(MODES)('Sandlord hub from town at session open (%s)', (_label, control) => {
  it('hub entered from town: the bubble starts, no map', () => {
    const o = rig({control});
    o.play(() => {
      o.go(TOWN, SANDLORD_HUB);
      o.adv(5_000);
    });
    expect(o.seasonal('sandlord')?.active).toBe(true);
    expect(o.seasonal('sandlord')?.ownsBubble).toBe(true);
    expect(o.map()).toBeNull();
    expect(ctx(o.e).inMap).toBe(false);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(10_000);
    o.drop(2);
    o.go(SANDLORD_HUB, TOWN);

    expect(o.shape()).toEqual([{primary: 'sandlord', overlaps: []}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(10_000);
    expect(u.tracker.drops[LOOT]).toBe(2);
    o.assertClean();
  });

  it('inside a hub sub-map (location stays hub): the bubble starts and absorbs the sub-map', () => {
    const o = rig({control});
    o.play(() => {
      o.go(TOWN, SANDLORD_HUB);
      o.go(SANDLORD_HUB, SANDLORD_SUB_MAP);
      o.adv(5_000);
    });
    expect(o.seasonal('sandlord')?.active).toBe(true);
    expect(o.map()).toBeNull();
    expect(ctx(o.e).inMap).toBe(false);
    o.adv(10_000);
    o.drop(2);
    o.go(SANDLORD_SUB_MAP, TOWN);

    expect(o.shape()).toEqual([{primary: 'sandlord', overlaps: []}]);
    expect(o.units()[0].tracker.drops[LOOT]).toBe(2);
    o.assertClean();
  });
});

describe('Vorex abandon seen before init', () => {
  const control = false;   // no control: post-init the s13_start itself would start the run
  it('the reward-zone scene after init still starts the run (the abandon was already committed)', () => {
    const o = rig({control});
    o.play(() => {
      o.go(TOWN, MAP);
      o.adv(10_000);
      o.line(log.s13Start);
      o.adv(5_000);
      o.line(log.s13WindowClose);                // the commit sequence: close + abandon, then the zone
      o.line(log.s13Abandon);
      o.adv(1_000);
    });
    // The window is closed: no interlude in progress yet, the map is live and nothing started.
    expect(o.seasonal('vorex')).toBeNull();
    expect(o.map()?.active).toBe(true);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(10_000);

    o.go(MAP, VOREX_REWARD);
    expect(o.seasonal('vorex')?.active).toBe(true);
    expect(o.map()?.active).toBe(false);
    o.adv(20_000);
    o.drop(3);
    o.go(VOREX_REWARD, TOWN);

    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['vorex']}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(10_000);
    expect(u.tracker.drops[LOOT] ?? 0).toBe(0);
    expect(u.overlaps[0].tracker.elapsed).toBe(20_000);
    expect(u.overlaps[0].tracker.drops[LOOT]).toBe(3);
    o.assertClean();
  });
});

describe('an interlude that finished before init starts nothing', () => {
  const control = false;   // no control: post-init a finished interlude IS a saved run
  const FINISHED: Array<[string, (o: Rig) => void]> = [
    ['Arcana panel opened and closed on a map', o => {
      o.go(TOWN, MAP); o.line(log.s9Minigame); o.adv(5_000); o.line(log.s9Close); o.adv(1_000);
    }],
    ['Arcana fight left back to the map', o => {
      o.go(TOWN, MAP); o.line(log.s9Minigame); o.go(MAP, ARCANA_FIGHT); o.adv(5_000); o.go(ARCANA_FIGHT, MAP); o.adv(1_000);
    }],
    ['Vorex window closed on a map', o => {
      o.go(TOWN, MAP); o.line(log.s13Start); o.adv(5_000); o.line(log.s13WindowClose); o.adv(1_000);
    }],
    ['Tartarus board closed (Esc) on a map', o => {
      o.go(TOWN, MAP); o.line(log.s16BoardOpen); o.adv(5_000); o.line(log.s16BoardClose); o.adv(1_000);
    }],
    ['Tartarus board abandoned (Ignore) on a map', o => {
      o.go(TOWN, MAP); o.line(log.s16BoardOpen); o.adv(5_000); o.line(log.s16Ignore); o.line(log.s16BoardClose); o.adv(1_000);
    }],
    ['Tartarus settled-board replay dismissed on a map', o => {
      o.go(TOWN, MAP); o.line(log.s16BoardOpenSettled); o.line(log.s16Ignore); o.line(log.s16BoardClose); o.adv(1_000);
    }],
    ['Dream entered and left on a map', o => {
      o.go(TOWN, MAP); o.line(log.levelType(11)); o.adv(5_000); o.line(log.levelType(3)); o.adv(1_000);
    }],
  ];

  it.each(FINISHED)('%s', (_name, pre) => {
    const o = rig({control});
    o.play(() => pre(o));
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.map()?.active).toBe(true);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(10_000);
    o.drop(1);
    o.go(MAP, TOWN);

    expect(o.shape()).toEqual([{primary: 'map', overlaps: []}]);
    const [u] = o.units();
    expect(u.tracker.elapsed).toBe(10_000);
    expect(u.tracker.drops[LOOT]).toBe(1);
    expect(u.checkpoint.mapTime).toBe(10_000);
    o.assertClean();
  });

  it('a Sandlord hub run that ended before init (hub -> town)', () => {
    const o = rig({control});
    o.play(() => {
      o.go(TOWN, SANDLORD_HUB); o.adv(5_000); o.go(SANDLORD_HUB, TOWN); o.adv(1_000);
    });
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.map()).toBeNull();
    o.adv(10_000);
    expect(o.units()).toEqual([]);
    o.assertClean();
  });

  it('a town Arcana panel closed before init is not revived by init', () => {
    const o = rig({control});
    o.play(() => {
      o.line(log.s9Minigame); o.adv(5_000); o.line(log.s9Close); o.adv(1_000);
    });
    // Control note: post-init, the closed panel leaves a parked (dormant) run — that is the ordinary
    // flow; pre-init nothing exists to carry over. Either way nothing is LIVE and nothing froze.
    expect(o.seasonal('arcana')?.active ?? false).toBe(false);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.adv(10_000);
    o.assertClean();
  });
});
