/**
 * 3.1b adversarial: the session-open hooks (init + Reset) against every way an
 * interlude can END (no ghost), every way it can be IN PROGRESS (exactly one
 * run), pause/resume cycles, Reset spam, and bag-init interleaving.
 * Reuses interlude-fixtures (rig / OwnerWatcher / checkUnits / checkCheckpoints).
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {SeasonalType} from '@/shared/contracts/engine';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TARTARUS_FIGHT, TOWN, VOREX_REWARD,
  ctx, feed, log,
} from './seasonal-fixtures';
import {INV, LOOT, rig, type Rig} from './interlude-fixtures';
import {beginSession} from './identity-fixtures';
import {useEngineStore} from '@/state/engineStore';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

interface EndPath {
  name:      string;
  /** The interlude, from a running map to its END (nothing left in progress). */
  run:       (o: Rig) => void;
  /** Where the player is afterwards. */
  endsIn:    'map' | 'town';
}

const PATHS: EndPath[] = [
  {name: 'arcana: s9_close', endsIn: 'map',
    run: o => { o.line(log.s9Minigame); o.adv(1_000); o.line(log.s9Close); }},
  {name: 'arcana: fight -> town', endsIn: 'town',
    run: o => { o.line(log.s9Minigame); o.go(MAP, ARCANA_FIGHT); o.adv(1_000); o.go(ARCANA_FIGHT, TOWN); }},
  {name: 'arcana: fight -> back to the map', endsIn: 'map',
    run: o => { o.line(log.s9Minigame); o.go(MAP, ARCANA_FIGHT); o.adv(1_000); o.go(ARCANA_FIGHT, MAP); }},
  {name: 'arcana: close then town', endsIn: 'town',
    run: o => { o.line(log.s9Minigame); o.line(log.s9Close); o.go(MAP, TOWN); }},
  {name: 'arcana: panel left by a zone change', endsIn: 'town',
    run: o => { o.line(log.s9Fight); o.go(MAP, TOWN); }},
  {name: 'vorex: window closed', endsIn: 'map',
    run: o => { o.line(log.s13Start); o.adv(1_000); o.line(log.s13WindowClose); }},
  {name: 'vorex: abandon -> reward -> town', endsIn: 'town',
    run: o => {
      o.line(log.s13Start); o.line(log.s13WindowClose); o.line(log.s13Abandon);
      o.go(MAP, VOREX_REWARD); o.adv(1_000); o.go(VOREX_REWARD, TOWN);
    }},
  {name: 'vorex: abandon -> straight to town', endsIn: 'town',
    run: o => { o.line(log.s13Start); o.line(log.s13WindowClose); o.line(log.s13Abandon); o.go(MAP, TOWN); }},
  {name: 'tartarus: Esc', endsIn: 'map',
    run: o => { o.line(log.s16BoardOpen); o.adv(1_000); o.line(log.s16BoardClose); }},
  {name: 'tartarus: ignore', endsIn: 'map',
    run: o => { o.line(log.s16BoardOpen); o.line(log.s16Ignore); o.line(log.s16BoardClose); }},
  {name: 'tartarus: suppress -> prison -> town', endsIn: 'town',
    run: o => {
      o.line(log.s16BoardOpen); o.line(log.s16Suppress); o.line(log.s16BoardClose);
      o.go(MAP, TARTARUS_FIGHT); o.adv(1_000); o.go(TARTARUS_FIGHT, TOWN);
    }},
  {name: 'tartarus: suppress -> prison -> back to the map', endsIn: 'map',
    run: o => {
      o.line(log.s16BoardOpen); o.line(log.s16Suppress); o.line(log.s16BoardClose);
      o.go(MAP, TARTARUS_FIGHT); o.adv(1_000); o.go(TARTARUS_FIGHT, MAP);
    }},
  {name: 'tartarus: suppress that never reaches the prison', endsIn: 'town',
    run: o => { o.line(log.s16BoardOpen); o.line(log.s16Suppress); o.line(log.s16BoardClose); o.go(MAP, TOWN); }},
  {name: 'tartarus: settled-board replay (dismissed)', endsIn: 'map',
    run: o => { o.line(log.s16BoardOpenSettled); o.line(log.s16Ignore); o.line(log.s16BoardClose); }},
  {name: 'dream: 11 -> 3', endsIn: 'map',
    run: o => { o.line(log.levelType(11)); o.adv(1_000); o.line(log.levelType(3)); }},
  {name: 'sandlord hub -> town', endsIn: 'town',
    run: o => { o.go(MAP, SANDLORD_HUB); o.adv(1_000); o.go(SANDLORD_HUB, TOWN); }},
  {name: 'sandlord hub + sub-map -> town', endsIn: 'town',
    run: o => { o.go(MAP, SANDLORD_HUB); o.go(SANDLORD_HUB, SANDLORD_SUB_MAP); o.adv(1_000); o.go(SANDLORD_SUB_MAP, TOWN); }},
];

/** The shape every "nothing in progress" state must have. */
function expectQuiet(o: Rig, endsIn: 'map' | 'town', label: string): void {
  const c = ctx(o.e);
  expect(c.registry.seasonalsSize(), `${label}: no seasonal`).toBe(0);
  expect(c.mapPausedForInterludeAt, `${label}: no interlude marker`).toBeNull();
  if (endsIn === 'map') {
    expect(o.map(), `${label}: map exists`).not.toBeNull();
    expect(o.map()?.active, `${label}: map running`).toBe(true);
  } else {
    expect(o.map(), `${label}: no map`).toBeNull();
  }
}

describe('session open: no ghost interlude after every kind of END', () => {
  it.each(PATHS)('init after $name starts no seasonal', (p) => {
    const o = rig();
    o.play(() => { o.go(TOWN, MAP); p.run(o); });
    expectQuiet(o, p.endsIn, 'init');
    expect(ctx(o.e).mapCount).toBe(p.endsIn === 'map' ? 1 : 0);
    // and the session behaves like an ordinary one from here: a fresh interlude still works
    if (p.endsIn === 'map') {
      o.line(log.s13Start);
      expect(o.seasonal('vorex')?.active).toBe(true);
      expect(o.map()?.active).toBe(false);
    }
  });

  it.each(PATHS)('Reset after $name (x3) starts no seasonal, and a second round is clean', (p) => {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);
    p.run(o);
    for (let i = 0; i < 3; i++) { o.reset(); expectQuiet(o, p.endsIn, `reset #${i + 1}`); }

    // second round: the stale flags (if any) would show up as a ghost or a missing freeze
    if (p.endsIn === 'town') o.go(TOWN, MAP);
    p.run(o);
    o.reset();
    expectQuiet(o, p.endsIn, 'second round');
    o.assertClean();
  });

  it.each(PATHS)('$name entirely while PAUSED, then resume, then Reset: no ghost', (p) => {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);
    o.pause();
    p.run(o);
    o.resume();
    o.reset();
    expectQuiet(o, p.endsIn, 'after reset');
    o.assertClean();
  });

  it.each(PATHS)('$name, Reset while paused, resume: no ghost', (p) => {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);
    p.run(o);
    o.pause();
    o.reset();
    o.resume();
    expectQuiet(o, p.endsIn, 'resumed');
    o.adv(5_000);
    if (p.endsIn === 'map') expect(o.map()?.elapsed()).toBe(5_000);
    o.assertClean();
  });
});

describe('Reset: a run in progress is replaced by exactly ONE fresh run', () => {
  interface Live {name: string; type: SeasonalType; open: (o: Rig) => void; frozenMap: boolean}
  const LIVE: Live[] = [
    {name: 'arcana panel',   type: 'arcana',   frozenMap: true,  open: o => { o.line(log.s9Minigame); o.adv(2_000); }},
    {name: 'arcana fight',   type: 'arcana',   frozenMap: true,  open: o => { o.line(log.s9Minigame); o.go(MAP, ARCANA_FIGHT); o.adv(2_000); o.drop(1); }},
    {name: 'vorex window',   type: 'vorex',    frozenMap: true,  open: o => { o.line(log.s13Start); o.adv(2_000); }},
    {name: 'tartarus board', type: 'tartarus', frozenMap: true,  open: o => { o.line(log.s16BoardOpen); o.adv(2_000); }},
    {name: 'tartarus prison', type: 'tartarus', frozenMap: true, open: o => {
      o.line(log.s16BoardOpen); o.line(log.s16Suppress); o.line(log.s16BoardClose);
      o.go(MAP, TARTARUS_FIGHT); o.adv(2_000);
    }},
    {name: 'sandlord hub',   type: 'sandlord', frozenMap: true,  open: o => { o.go(MAP, SANDLORD_HUB); o.adv(2_000); o.drop(1); }},
    {name: 'dream',          type: 'dream',    frozenMap: false, open: o => { o.line(log.levelType(11)); o.adv(2_000); o.drop(1); }},
  ];

  it.each(LIVE)('$name: Reset x5 leaves one live run, one session start per reset, one unit overlap at the end', (c) => {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);
    o.adv(3_000);
    c.open(o);
    for (let i = 0; i < 5; i++) {
      const at = o.events.length;
      o.reset();
      const after = o.events.slice(at);
      expect(ctx(o.e).registry.seasonalsSize(), `reset #${i}`).toBe(1);
      expect(o.seasonal(c.type)?.active).toBe(true);
      expect(o.seasonal(c.type)?.snapshot().elapsed).toBe(0);
      expect(after.filter(e => e.type === 'tracker_started' && e.tracker.kind === 'session')).toHaveLength(1);
      expect(after.filter(e => e.type === 'tracker_started' && e.tracker.kind === 'seasonal')).toHaveLength(1);
      expect(after.filter(e => e.type === 'unit_finished')).toHaveLength(0);
      expect(o.map()?.active, 'map frozen iff the interlude freezes it').toBe(!c.frozenMap);
      expect(ctx(o.e).mapCount).toBe(1);
    }
    o.adv(7_000);
    expect(o.seasonal(c.type)?.snapshot().elapsed).toBe(7_000);
    expect(o.map()?.elapsed()).toBe(c.frozenMap ? 0 : 7_000);
    o.go(MAP, TOWN);                                    // town entry ends everything
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.units()).toHaveLength(1);
    expect(o.units()[0].overlaps.map(x => x.tracker.seasonalType)).toEqual([c.type]);
    o.assertClean();
  });

  it('Dream at level 11: Reset, paused cycles, then 11 -> 3 ends exactly one run', () => {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);
    o.line(log.levelType(11));
    o.pause();
    o.reset();
    o.reset();
    expect(o.seasonal('dream')?.active).toBe(false);
    for (let i = 0; i < 3; i++) {
      o.resume(); o.adv(1_000);
      expect(o.seasonal('dream')?.active).toBe(true);
      o.pause();  o.adv(9_000);
      expect(o.seasonal('dream')?.active).toBe(false);
    }
    o.resume();
    expect(o.seasonal('dream')?.snapshot().elapsed).toBe(3_000);
    expect(o.map()?.elapsed()).toBe(3_000);              // in-map: map clock ran with it
    o.line(log.levelType(3));
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    o.reset();
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);   // 11 -> 3 consumed: no ghost dream
    o.assertClean();
  });

  it('Reset while paused inside an interlude: pause/resume cycles keep the map frozen and the run honest', () => {
    for (const [type, open] of [
      ['arcana',   (o: Rig) => { o.line(log.s9Minigame); }],
      ['vorex',    (o: Rig) => { o.line(log.s13Start); }],
      ['tartarus', (o: Rig) => { o.line(log.s16BoardOpen); }],
    ] as const) {
      const o = rig();
      o.init(); o.go(TOWN, MAP); o.adv(1_000);
      open(o);
      o.pause(); o.reset();
      for (let i = 0; i < 3; i++) {
        o.resume();
        expect(o.map()?.active, `${type} resume #${i}`).toBe(false);
        expect(o.seasonal(type)?.active).toBe(true);
        o.adv(2_000);
        o.pause();
        o.adv(5_000);
      }
      expect(o.seasonal(type)?.snapshot().elapsed).toBe(6_000);
      expect(o.map()?.elapsed()).toBe(0);
      o.resume();
      o.go(MAP, TOWN);
      expect(o.units()[0].tracker.elapsed).toBe(0);
      expect(o.units()[0].overlaps[0].tracker.elapsed).toBe(6_000);
      o.assertClean();
    }
  });

  it('Reset spam outside any interlude (town and map) never invents a seasonal', () => {
    const o = rig();
    o.init();
    for (let i = 0; i < 4; i++) o.reset();
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    o.go(TOWN, MAP);
    for (let i = 0; i < 4; i++) { o.reset(); expect(o.map()?.active).toBe(true); expect(ctx(o.e).registry.seasonalsSize()).toBe(0); }
    o.assertClean();
  });
});

describe('Reset: pending interlude transitions are carried across the Reset', () => {
  it('Vorex abandon committed, Reset BEFORE the reward-zone transition: the run still starts there', () => {
    const o = rig();
    o.init(); o.go(TOWN, MAP); o.adv(1_000);
    o.line(log.s13Start); o.line(log.s13WindowClose); o.line(log.s13Abandon);
    o.reset();                                  // nothing to freeze yet: the window is gone, the zone is pending
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    o.go(MAP, VOREX_REWARD);
    expect(o.seasonal('vorex')?.active).toBe(true);
    expect(o.map()?.active).toBe(false);
    o.adv(3_000);
    o.go(VOREX_REWARD, TOWN);
    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['vorex']}]);
    expect(o.units()[0].tracker.elapsed).toBe(0);
    o.assertClean();
  });

  it('Tartarus Suppress committed, Reset BEFORE the prison transition: one run, frozen map, ends at town', () => {
    const o = rig();
    o.init(); o.go(TOWN, MAP); o.adv(1_000);
    o.line(log.s16BoardOpen); o.line(log.s16Suppress); o.line(log.s16BoardClose);
    o.reset();
    expect(ctx(o.e).registry.seasonalsSize()).toBe(1);
    expect(o.map()?.active).toBe(false);
    o.go(MAP, TARTARUS_FIGHT);
    expect(ctx(o.e).registry.seasonalsSize()).toBe(1);   // the prison entry adopts it, no second run
    o.adv(2_000);
    o.go(TARTARUS_FIGHT, TOWN);
    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['tartarus']}]);
    o.assertClean();
  });

  it('Arcana panel open, Reset, THEN the fight transition: one run through the fight', () => {
    const o = rig();
    o.init(); o.go(TOWN, MAP);
    o.line(log.s9Minigame); o.adv(1_000);
    o.reset();
    o.line(log.s9Fight);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(4_000);
    o.drop(2);
    expect(ctx(o.e).registry.seasonalsSize()).toBe(1);
    expect(o.seasonal('arcana')?.snapshot().drops[LOOT]).toBe(2);
    o.go(ARCANA_FIGHT, TOWN);
    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['arcana']}]);
    o.assertClean();
  });
});

describe('hub sub-map at Reset / init', () => {
  it('Reset inside a hub sub-map: the bubble is fresh, sub-map loot is the bubble\'s, map time stays 0', () => {
    const o = rig();
    o.init(); o.go(TOWN, MAP); o.adv(2_000);
    o.go(MAP, SANDLORD_HUB); o.go(SANDLORD_HUB, SANDLORD_SUB_MAP); o.adv(2_000);
    expect(ctx(o.e).location).toBe('hub');
    o.reset();
    expect(ctx(o.e).location).toBe('hub');
    expect(o.seasonal('sandlord')?.phase).toBe('hub');
    expect(o.seasonal('sandlord')?.active).toBe(true);
    expect(o.map()?.active).toBe(false);
    o.adv(3_000);
    o.drop(3);
    expect(o.seasonal('sandlord')?.snapshot().drops[LOOT]).toBe(3);
    expect(o.map()?.snapshot().drops[LOOT] ?? 0).toBe(0);
    o.go(SANDLORD_SUB_MAP, TOWN);
    expect(o.shape()).toEqual([{primary: 'map', overlaps: ['sandlord']}]);
    expect(o.units()[0].tracker.elapsed).toBe(0);
    o.assertClean();
  });

  it('init inside a hub sub-map entered from town (no map run): standalone bubble, nothing else', () => {
    const o = rig();
    o.play(() => { o.go(TOWN, SANDLORD_HUB); o.go(SANDLORD_HUB, SANDLORD_SUB_MAP); });
    expect(o.map()).toBeNull();
    expect(o.seasonal('sandlord')?.phase).toBe('hub');
    o.drop(2);
    expect(o.seasonal('sandlord')?.snapshot().drops[LOOT]).toBe(2);
    o.go(SANDLORD_SUB_MAP, TOWN);
    expect(o.shape()).toEqual([{primary: 'sandlord', overlaps: []}]);
    o.assertClean();
  });

  it('Reset inside an in-map Sandlord tile (phase map) does not start a hub run', () => {
    const o = rig();
    o.init(); o.go(TOWN, MAP); o.line(log.s10Wave);
    expect(o.seasonal('sandlord')?.phase).toBe('map');
    o.reset();
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);   // a tile run is not an interlude; Reset drops it like any in-map run
    expect(o.map()?.active).toBe(true);
  });
});

describe('two interludes\' state at once', () => {
  // GAMEPLAY / map-interlude.ts: "one interlude at a time". Real logs can leave a
  // panel flag stale (a panel closed with no s9_close), so a second interlude's
  // marker may arrive while the first flag is still set. In TRACKING both start
  // (before and after 382f4bd alike: the handlers are independent). A Reset must
  // then reproduce exactly the live picture, not invent a different one.
  it('Arcana panel flag + Vorex window: the post-Reset picture equals the live picture', () => {
    const o = rig();
    o.init(); o.go(TOWN, MAP); o.adv(1_000);
    o.line(log.s9Minigame);
    o.line(log.s13Start);
    const live = new Set([...ctx(o.e).registry.seasonals()].map(t => t.seasonalType));
    expect(o.map()?.active).toBe(false);
    o.reset();
    const after = new Set([...ctx(o.e).registry.seasonals()].map(t => t.seasonalType));
    expect(after).toEqual(live);
    expect(o.map()?.active).toBe(false);
    expect(ctx(o.e).mapPausedForInterludeAt).not.toBeNull();
    o.go(MAP, TOWN);
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(ctx(o.e).mapPausedForInterludeAt).toBeNull();
    o.assertClean();
  });
});

describe('bag init interleaved with the interlude\'s own lines', () => {
  /** Feed the bag dump with `mid` fired between its lines and the debounce. */
  function interleaved(script: (o: Rig) => void, place: 'between' | 'at-debounce-edge') {
    const o = rig();
    const [first, ...rest] = [{slotId: 1, itemId: LOOT, quantity: 0}, {slotId: 2, itemId: 900, quantity: 4}];
    feed(o.d, o.e, log.bagInit(first.slotId, first.itemId, first.quantity));
    if (place === 'between') {
      script(o);
      for (const r of rest) feed(o.d, o.e, log.bagInit(r.slotId, r.itemId, r.quantity));
      vi.advanceTimersByTime(500);
    } else {
      for (const r of rest) feed(o.d, o.e, log.bagInit(r.slotId, r.itemId, r.quantity));
      vi.advanceTimersByTime(499);
      script(o);                                        // 1 ms before the session opens
      vi.advanceTimersByTime(1);
    }
    return o;
  }

  const FIGHTS: Array<{name: string; type: SeasonalType; script: (o: Rig) => void; end: (o: Rig) => void}> = [
    {name: 'arcana', type: 'arcana',
      script: o => { o.go(TOWN, MAP); o.line(log.s9Minigame); o.go(MAP, ARCANA_FIGHT); },
      end:    o => o.go(ARCANA_FIGHT, TOWN)},
    {name: 'vorex', type: 'vorex',
      script: o => { o.go(TOWN, MAP); o.line(log.s13Start); o.line(log.s13WindowClose); o.line(log.s13Abandon); o.go(MAP, VOREX_REWARD); },
      end:    o => o.go(VOREX_REWARD, TOWN)},
    {name: 'tartarus', type: 'tartarus',
      script: o => { o.go(TOWN, MAP); o.line(log.s16BoardOpen); o.line(log.s16Suppress); o.line(log.s16BoardClose); o.go(MAP, TARTARUS_FIGHT); },
      end:    o => o.go(TARTARUS_FIGHT, TOWN)},
    {name: 'sandlord hub', type: 'sandlord',
      script: o => { o.go(TOWN, MAP); o.go(MAP, SANDLORD_HUB); },
      end:    o => o.go(SANDLORD_HUB, TOWN)},
  ];

  it.each(FIGHTS.flatMap(f => (['between', 'at-debounce-edge'] as const).map(p => [f.name, p, f] as const)))(
    '%s: transition into the fight %s the bag dump: one frozen-map run that ends normally',
    (_n, place, f) => {
      const o = interleaved(f.script, place);
      expect(ctx(o.e).phase).toBe('tracking');
      expect(ctx(o.e).registry.seasonalsSize()).toBe(1);
      expect(o.seasonal(f.type)?.active).toBe(true);
      expect(o.map()?.active).toBe(false);
      o.adv(2_000);
      o.drop(2);
      expect(o.seasonal(f.type)?.snapshot().drops[LOOT]).toBe(2);
      expect(o.map()?.snapshot().drops[LOOT] ?? 0).toBe(0);
      f.end(o);
      expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
      expect(o.shape()).toEqual([{primary: 'map', overlaps: [f.type]}]);
      expect(o.units()[0].tracker.elapsed).toBe(0);
      o.assertClean();
    },
  );

  it('the fight left again BEFORE the session opens starts nothing, whatever the interleaving', () => {
    const o = interleaved(oo => {
      oo.go(TOWN, MAP); oo.line(log.s9Minigame); oo.go(MAP, ARCANA_FIGHT); oo.go(ARCANA_FIGHT, TOWN);
    }, 'between');
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.map()).toBeNull();
  });

  it('a session continued from a saved run opens inside an interlude: counters seeded, run fresh, map frozen', () => {
    const o = rig();
    // beginSession already ran in the rig; restart it as a continue
    o.e.stop();
    beginSession(o.e, {loaded: {
      sessionId: 'old', name: 'Old', drops: {[LOOT]: 5}, dropsBySource: {}, spent: {}, totalTime: 100, mapTime: 60, mapCount: 3,
    }});
    o.go(TOWN, MAP);
    o.line(log.s9Minigame);
    o.init();
    expect(ctx(o.e).mapCount).toBe(4);
    expect(ctx(o.e).accumulatedMapTime).toBe(60_000);
    expect(o.seasonal('arcana')?.active).toBe(true);
    expect(o.map()?.active).toBe(false);
    o.adv(2_000);
    o.go(MAP, TOWN);
    expect(o.units()[0].tracker.elapsed).toBe(0);
    expect(o.units()[0].checkpoint.mapTime).toBe(60_000);
  });
});

/** A Stop discards the registry silently (no tracker_finished): drop the watcher's
 *  and the renderer store's view of the old session, as a real session switch does. */
function forgetPublished(o: Rig): void {
  o.w.published.clear();
  useEngineStore.getState().reset();
}

describe('state does not leak across sessions', () => {
  it.each([
    ['arcana panel', (o: Rig) => { o.line(log.s9Minigame); }, 'arcana'],
    ['vorex window', (o: Rig) => { o.line(log.s13Start); }, 'vorex'],
    ['tartarus board', (o: Rig) => { o.line(log.s16BoardOpen); }, 'tartarus'],
    ['dream', (o: Rig) => { o.line(log.levelType(11)); }, 'dream'],
  ] as const)('%s open at Stop: the next session starts clean (no flag survives onStop)', (_n, open, type) => {
    const o = rig();
    o.init(); o.go(TOWN, MAP);
    open(o);
    expect(o.seasonal(type)).not.toBeNull();
    o.e.stop();
    forgetPublished(o);                  // Stop emits no tracker_finished: session 1's view must not carry into session 2
    beginSession(o.e);
    o.go(TOWN, MAP);                     // a new log position: the old interlude is long gone
    o.init();
    o.reset();
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.map()?.active).toBe(true);
  });

  it('idle-phase noise (lines before Engine.start) is discarded by onStart', () => {
    const o = rig();
    o.e.stop();                          // idle
    forgetPublished(o);
    o.line(log.s9Minigame); o.line(log.s13Start); o.line(log.s16BoardOpen); o.line(log.levelType(11));
    beginSession(o.e);
    o.go(TOWN, MAP);
    o.init();
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.map()?.active).toBe(true);
  });
});

describe('map frozen exactly during interludes (invariant over a long mixed script)', () => {
  /** frozen-map marker <=> an interlude owns the map; checked after every step. */
  function inv(o: Rig, label: string): void {
    const c = ctx(o.e);
    const map = o.map();
    const marker = c.mapPausedForInterludeAt !== null;
    if (marker) expect(map === null || !map.active, `${label}: marker but map running`).toBe(true);
    if (map && !map.active && !c.paused) expect(marker, `${label}: map frozen without an interlude`).toBe(true);
    for (const t of c.registry.seasonals()) {
      if (t.active && t.seasonalType !== 'dream' && ['arcana', 'vorex', 'tartarus'].includes(t.seasonalType)) {
        expect(map === null || !map.active, `${label}: ${t.seasonalType} running with a live map`).toBe(true);
      }
    }
  }

  it('walks every path twice, with Resets and pauses sprinkled in', () => {
    const o = rig();
    o.init();
    let n = 0;
    for (const round of [0, 1]) {
      for (const p of PATHS) {
        o.go(TOWN, MAP); inv(o, `${p.name} enter`);
        o.adv(500);
        const wrapped = {...o, line: (l: string) => { o.line(l); inv(o, `${p.name} | ${l.slice(-30)}`); },
                              go:   (a: string, b: string) => { o.go(a, b); inv(o, `${p.name} go ${b.slice(-14)}`); }} as Rig;
        p.run(wrapped);
        if (p.endsIn === 'map') o.go(MAP, TOWN);
        inv(o, `${p.name} end`);
        expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
        if (++n % 3 === 0) { o.reset(); inv(o, `${p.name} reset`); }
        if (n % 4 === 0)   { o.pause(); o.resume(); inv(o, `${p.name} pause`); }
        expect(round).toBeLessThan(2);
      }
    }
    o.assertClean();
  });
});

describe('Reset while inside an Arcana fight reached by the real flow, then leaving to a MAP', () => {
  it('fight -> back to the map after the Reset resumes the map and ends the run', () => {
    const o = rig();
    o.init(); o.go(TOWN, MAP); o.adv(1_000);
    o.line(log.s9Minigame); o.go(MAP, ARCANA_FIGHT); o.adv(2_000);
    o.reset();
    o.go(ARCANA_FIGHT, MAP);
    expect(ctx(o.e).registry.seasonalsSize()).toBe(0);
    expect(o.map()?.active).toBe(true);
    o.adv(1_000);
    o.go(MAP, TOWN);
    expect(o.units()[0].tracker.elapsed).toBe(1_000);
    o.assertClean();
  });

  it('keeps INV referenced (shared fixture)', () => { expect(INV).toHaveLength(1); });
});
