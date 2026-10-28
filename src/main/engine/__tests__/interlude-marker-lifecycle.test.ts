/**
 * The interlude marker ("an interlude froze the CURRENT map") is map state: it
 * must end with the map it froze. A panel interlude (Arcana tarot, Vorex
 * window, live Tartarus board) left open while the player goes map → town
 * gets no close marker — the map is finished by ZoneHandler, and the marker
 * must go with it. A stale marker made Engine.resume() refuse to resume the
 * NEXT map, so a pause/resume during it left that map frozen (map time lost).
 *
 * Invariant checked after every step: marker !== null ⇒ a map exists and is
 * frozen.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import {
  boot, createDispatcher, createEngine, ctx, feed, log,
  ARCANA_FIGHT, MAP, SANDLORD_HUB, TARTARUS_FIGHT, TOWN, VOREX_REWARD,
} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

function rig() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e: Engine = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);

  const c = () => ctx(e);
  const invariant = (label: string) => {
    const reg = c().registry;
    if (c().mapPausedForInterludeAt !== null) {
      expect(reg.map, `${label}: marker set ⇒ a map exists`).not.toBeNull();
      expect(reg.map!.active, `${label}: marker set ⇒ the map is frozen`).toBe(false);
    }
  };

  return {
    e, events, c,
    line:   (l: string) => { feed(d, e, l); invariant(l.slice(-40)); },
    go:     (from: string, to: string) => { feed(d, e, log.zoneTransition(from, to)); invariant(`go ${to.slice(-24)}`); },
    adv:    (ms: number) => { vi.advanceTimersByTime(ms); invariant(`adv ${ms}`); },
    pause:  () => { e.pause();  invariant('pause'); },
    resume: () => { e.resume(); invariant('resume'); },
    mapEnded: () => events.filter((ev): ev is Extract<EngineEvent, {type: 'map_ended'}> => ev.type === 'map_ended').map(ev => ev.elapsed),
    invariant,
  };
}

type Rig = ReturnType<typeof rig>;

/** The next map, with a session pause/resume inside it, must RUN after the
 *  resume and be credited exactly its live time. `firstMapMs` is what the
 *  previous (interlude-frozen) map contributed. */
function nextMapSurvivesPause(o: Rig, firstMapMs: number) {
  o.go(TOWN, MAP);
  expect(o.c().registry.map!.active).toBe(true);
  o.adv(10_000);
  o.pause();
  o.adv(30_000);
  o.resume();
  expect(o.c().registry.map!.active, 'the next map resumes with the session').toBe(true);
  o.adv(20_000);
  expect(o.c().registry.map!.elapsed()).toBe(30_000);
  o.go(MAP, TOWN);
  expect(o.mapEnded().at(-1)).toBe(30_000);
  expect(o.c().accumulatedMapTime).toBe(firstMapMs + 30_000);
}

// ---------------------------------------------------------------------------
// Panel left open into town — no close marker
// ---------------------------------------------------------------------------

describe('A panel interlude left open into town ends with its map', () => {
  const panels: Array<[string, string]> = [
    ['Arcana tarot panel', log.s9Minigame],
    ['Vorex window',       log.s13Start],
    ['Tartarus live board', log.s16BoardOpen],
  ];

  for (const [name, open] of panels) {
    it(`${name}: marker cleared at town, next map pause/resume runs`, () => {
      const o = rig();
      o.go(TOWN, MAP);
      o.adv(10_000);
      o.line(open);
      expect(o.c().mapPausedForInterludeAt).not.toBeNull();
      expect(o.c().registry.map!.active).toBe(false);
      o.adv(15_000); // interlude time — excluded from the map

      o.go(MAP, TOWN); // no close marker
      expect(o.c().registry.map).toBeNull();
      expect(o.c().mapPausedForInterludeAt).toBeNull();
      expect(o.mapEnded()).toEqual([10_000]);

      nextMapSurvivesPause(o, 10_000);
    });

    it(`${name}: left open into town while session-paused — marker cleared, next map runs`, () => {
      const o = rig();
      o.go(TOWN, MAP);
      o.adv(10_000);
      o.line(open);
      o.pause();
      o.adv(5_000);
      o.go(MAP, TOWN);
      expect(o.c().mapPausedForInterludeAt).toBeNull();
      o.resume();
      nextMapSurvivesPause(o, 10_000);
    });
  }
});

// ---------------------------------------------------------------------------
// Fight scene straight to town (the handlers resolve these; regression guard)
// ---------------------------------------------------------------------------

describe('A fight scene exited straight to town ends the marker with its map', () => {
  it('Arcana: map → panel → fight → town', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.line(log.s9Minigame);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(20_000);
    o.go(ARCANA_FIGHT, TOWN);
    expect(o.c().mapPausedForInterludeAt).toBeNull();
    expect(o.mapEnded()).toEqual([10_000]);
    nextMapSurvivesPause(o, 10_000);
  });

  it('Vorex: map → window → commit → reward zone → town', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.line(log.s13Start);
    o.adv(5_000);
    o.line(log.s13WindowClose);
    o.line(log.s13Abandon);
    o.go(MAP, VOREX_REWARD);
    o.adv(20_000);
    o.go(VOREX_REWARD, TOWN);
    expect(o.c().mapPausedForInterludeAt).toBeNull();
    expect(o.mapEnded()).toEqual([10_000]);
    nextMapSurvivesPause(o, 10_000);
  });

  it('Tartarus: map → board → suppress → prison → town', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.line(log.s16BoardOpen);
    o.adv(5_000);
    o.line(log.s16Suppress);
    o.line(log.s16BoardClose);
    o.go(MAP, TARTARUS_FIGHT);
    o.adv(20_000);
    o.go(TARTARUS_FIGHT, TOWN);
    expect(o.c().mapPausedForInterludeAt).toBeNull();
    expect(o.mapEnded()).toEqual([10_000]);
    nextMapSurvivesPause(o, 10_000);
  });

  it('Sandlord: map → hub → town, paused inside the hub', () => {
    const o = rig();
    o.go(TOWN, MAP);
    o.adv(10_000);
    o.go(MAP, SANDLORD_HUB);
    o.adv(5_000);
    o.pause();
    o.go(SANDLORD_HUB, TOWN);
    expect(o.c().mapPausedForInterludeAt).toBeNull();
    o.resume();
    expect(o.mapEnded()).toEqual([10_000]);
    nextMapSurvivesPause(o, 10_000);
  });
});

// ---------------------------------------------------------------------------
// Mixed script — the invariant holds after every step
// ---------------------------------------------------------------------------

describe('Interlude marker invariant over a mixed script', () => {
  it('marker set ⇒ a map exists and is frozen, after every event', () => {
    const o = rig();
    // Map 1: Arcana panel left open into town.
    o.go(TOWN, MAP);
    o.adv(5_000);
    o.line(log.s9Minigame);
    o.adv(5_000);
    o.go(MAP, TOWN);
    // Map 2: Tartarus board opened, session paused around it, left into town.
    o.go(TOWN, MAP);
    o.adv(5_000);
    o.line(log.s16BoardOpen);
    o.pause();
    o.adv(5_000);
    o.resume();
    expect(o.c().registry.map!.active).toBe(false); // the board still owns the pause
    o.go(MAP, TOWN);
    // Town-started Vorex window (no map) then into a map with it still open.
    o.line(log.s13Start);
    o.go(TOWN, MAP);
    o.adv(5_000);
    o.line(log.s13WindowClose);
    o.adv(5_000);
    // Map 3: Vorex window reopened mid-map, then pause/resume, then town.
    o.line(log.s13Start);
    o.pause();
    o.resume();
    o.go(MAP, TOWN);
    // Map 4: a clean map with a pause — must run.
    o.go(TOWN, MAP);
    o.adv(5_000);
    o.pause();
    o.adv(5_000);
    o.resume();
    expect(o.c().registry.map!.active).toBe(true);
    o.adv(5_000);
    o.go(MAP, TOWN);

    // Maps: 5s, 5s, 10s (5 before the window + 5 after its close), 10s.
    expect(o.mapEnded()).toEqual([5_000, 5_000, 10_000, 10_000]);
    expect(o.c().accumulatedMapTime).toBe(30_000);
    expect(o.c().mapPausedForInterludeAt).toBeNull();
  });
});
