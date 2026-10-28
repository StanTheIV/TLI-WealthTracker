/**
 * Adversarial cases for the session pause now that the frozen-seasonal set
 * lives in the registry (freezeForSessionPause / freezeAllForSessionPause /
 * thawSessionPause), and for pauseMapForInterlude claiming a map the session
 * pause froze. Production chain only.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import {
  TEST_IDENTITY,
  ARCANA_FIGHT, MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TARTARUS_FIGHT, TOWN, VOREX_REWARD,
  boot, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {dropsBySource, sessionDrops} from './location-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const ITEM = 800;

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 10}]);
  events.length = 0;
  const line = (l: string) => feed(d, e, l);
  const go   = (from: string, to: string) => line(log.zoneTransition(from, to));
  const bag  = (qty: number) => { line(log.bagUpdate(1, ITEM, qty)); vi.advanceTimersByTime(2_000); };
  const reg  = () => ctx(e).registry;
  return {events, d, e, line, go, bag, reg};
}

describe('session pause: whoever paused it resumes it', () => {
  it('active + self-paused (backed-out Arcana) + loot window: only the session-frozen ones resume', () => {
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    line(log.s11Start);                 // carjack: active in-map mechanic
    line(log.s9Minigame);               // arcana opens: map interlude-frozen
    line(log.s9Close);                  // backed out: arcana self-paused, map resumed
    line(log.s12Entry);                 // overrealm
    line(log.s12Exit);                  // overrealm loot window armed

    expect(reg().seasonal('arcana')?.active).toBe(false);
    expect(reg().seasonal('overrealm')?.isLootCollecting()).toBe(true);

    e.pause();
    expect(reg().map?.active).toBe(false);
    expect(reg().seasonal('carjack')?.active).toBe(false);
    expect(reg().seasonal('overrealm')?.active).toBe(false);

    vi.advanceTimersByTime(120_000);    // long pause: a frozen window must not expire
    expect(reg().seasonal('overrealm')).not.toBeNull();
    expect(reg().seasonal('overrealm')?.isLootCollecting()).toBe(true);

    e.resume();
    expect(reg().map?.active).toBe(true);
    expect(reg().seasonal('carjack')?.active).toBe(true);
    expect(reg().seasonal('overrealm')?.active).toBe(true);
    expect(reg().seasonal('arcana')?.active).toBe(false);   // self-paused stays paused
    expect(reg().seasonal('overrealm')?.isLootCollecting()).toBe(true);
  });

  it('the loot window keeps its remaining time across a pause', () => {
    const {e, line, go, reg} = setup();
    e.setOverrealmLootDurationMs(10_000);
    go(TOWN, MAP);
    line(log.s12Entry);
    line(log.s12Exit);
    vi.advanceTimersByTime(4_000);

    e.pause();
    vi.advanceTimersByTime(60_000);
    e.resume();

    vi.advanceTimersByTime(5_000);      // 4 + 5 = 9 < 10: still alive
    expect(reg().seasonal('overrealm')).not.toBeNull();
    vi.advanceTimersByTime(1_500);      // > 10 total: expired and finished
    expect(reg().seasonal('overrealm')).toBeNull();
  });

  it('a seasonal that finishes while paused is not resurrected by the resume', () => {
    const {e, line, go, reg, events} = setup();
    go(TOWN, MAP);
    line(log.s11Start);
    e.pause();
    go(MAP, TOWN);                      // town entry finishes everything while paused
    expect(reg().seasonal('carjack')).toBeNull();

    events.length = 0;
    e.resume();
    expect(reg().seasonal('carjack')).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === 'carjack')).toBe(false);
  });

  it('a same-type seasonal started AFTER a finish-during-pause is not resumed by a stale entry', () => {
    // Old behaviour keyed the set by type, so a new tracker of the same type
    // would have been resumed by the resume. Arcana is started after the
    // resume's pause here: pause -> finish -> resume -> new tracker stays as-is.
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    line(log.s11Start);
    e.pause();
    go(MAP, TOWN);
    e.resume();
    go(TOWN, MAP);
    line(log.s11Start);
    const t = reg().seasonal('carjack');
    expect(t?.active).toBe(true);
    e.pause();
    e.resume();
    expect(reg().seasonal('carjack')?.active).toBe(true);
  });

  it('double pause then one resume resumes everything; a second pause is a no-op', () => {
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    line(log.s11Start);
    e.pause();
    e.pause();                          // must not re-record a now-inactive tracker as "ours"
    e.resume();
    expect(reg().map?.active).toBe(true);
    expect(reg().seasonal('carjack')?.active).toBe(true);
  });

  it('resume without a pause changes nothing', () => {
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    line(log.s9Minigame);
    line(log.s9Close);                  // arcana self-paused
    e.resume();
    expect(reg().seasonal('arcana')?.active).toBe(false);
    expect(reg().map?.active).toBe(true);
  });

  it('pause / resume / resume: the second resume does not resume a later self-pause', () => {
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    line(log.s9Minigame);
    e.pause();
    e.resume();                         // arcana resumed
    line(log.s9Close);                  // self-pause now
    e.resume();                         // no-op
    expect(reg().seasonal('arcana')?.active).toBe(false);
    e.pause();
    e.resume();                         // arcana was inactive at pause: must stay so
    expect(reg().seasonal('arcana')?.active).toBe(false);
  });

  it('Engine.reset() while paused drops the frozen set: resume does not touch fresh trackers', () => {
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    line(log.s11Start);
    e.pause();
    e.reset(TEST_IDENTITY);                          // finishes seasonals, keeps pause state
    expect(reg().seasonal('carjack')).toBeNull();
    e.resume();
    expect(reg().session?.active).toBe(true);
    expect(reg().map?.active).toBe(true);
    expect(reg().seasonalsSize()).toBe(0);
  });

  it('stop while paused clears the set: a fresh engine run resumes cleanly', () => {
    const {e, line, go, d} = setup();
    go(TOWN, MAP);
    line(log.s11Start);
    e.pause();
    e.stop();
    e.start(TEST_IDENTITY);
    feed(d, e, log.bagInit(1, ITEM, 10));
    vi.advanceTimersByTime(600);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s11Start);
    e.pause();
    e.resume();
    expect(ctx(e).registry.seasonal('carjack')?.active).toBe(true);
  });

  it('resume keeps the pre-pause ownership order (mechanical resume does not bump)', () => {
    const {e, line, go, bag, reg} = setup();
    go(TOWN, MAP);
    line(log.s14Strum);                 // lunaria first
    line(log.s11Start);                 // carjack newer -> owns drops
    e.pause();
    e.resume();
    bag(14);
    expect(reg().seasonal('carjack')?.snapshot().drops).toEqual({[ITEM]: 4});
    expect(reg().seasonal('lunaria')?.snapshot().drops ?? {}).toEqual({});
  });
});

describe('interlude opened while the session is paused claims the map freeze', () => {
  it('Arcana: pause in map, map -> fight, resume IN the fight, fight -> map: map frozen through the fight, runs after', () => {
    const {e, line, go, bag, reg} = setup();
    go(TOWN, MAP);
    bag(12);                            // +2 map loot
    line(log.s9Minigame);               // map interlude-frozen, arcana active
    e.pause();
    go(MAP, ARCANA_FIGHT);
    e.resume();

    expect(reg().map?.active).toBe(false);
    const before = reg().map!.elapsed();
    vi.advanceTimersByTime(30_000);
    expect(reg().map!.elapsed()).toBe(before);

    bag(30);                            // +18 fight loot
    expect(reg().map?.snapshot().drops).toEqual({[ITEM]: 2});
    expect(reg().seasonal('arcana')?.snapshot().drops).toEqual({[ITEM]: 18});

    go(ARCANA_FIGHT, MAP);
    expect(reg().map?.active).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(reg().map!.elapsed()).toBe(before + 5_000);
    expect(ctx(e).mapCount).toBe(1);
  });

  it('Arcana: pause, map -> fight (no tracked minigame), resume in fight: map frozen; fight -> map resumes it', () => {
    const {e, go, reg} = setup();
    go(TOWN, MAP);
    e.pause();
    go(MAP, ARCANA_FIGHT);
    e.resume();
    expect(reg().map?.active).toBe(false);
    go(ARCANA_FIGHT, MAP);
    expect(reg().map?.active).toBe(true);
  });

  it('Arcana: pause, map -> fight -> map while STILL paused, then resume: the map runs', () => {
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    line(log.s9Minigame);
    e.pause();
    go(MAP, ARCANA_FIGHT);
    go(ARCANA_FIGHT, MAP);
    expect(reg().map?.active).toBe(false);          // still paused
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
    e.resume();
    expect(reg().map?.active).toBe(true);
    expect(reg().seasonal('arcana')).toBeNull();    // finished leaving the fight
  });

  it('Tartarus prison: resume in the prison keeps the map frozen; prison -> map resumes it', () => {
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    line(log.s16BoardOpen);
    line(log.s16Suppress);
    e.pause();
    line(log.s16BoardClose);
    go(MAP, TARTARUS_FIGHT);
    e.resume();
    expect(reg().map?.active).toBe(false);
    go(TARTARUS_FIGHT, MAP);
    expect(reg().map?.active).toBe(true);
  });

  it('Tartarus prison: pause, map -> prison -> map while paused, resume: map runs', () => {
    const {e, go, reg} = setup();
    go(TOWN, MAP);
    e.pause();
    go(MAP, TARTARUS_FIGHT);
    go(TARTARUS_FIGHT, MAP);
    e.resume();
    expect(reg().map?.active).toBe(true);
  });

  it('Vorex reward zone: resume inside keeps the map frozen; to town finishes it off its frozen elapsed', () => {
    const {e, line, go, reg} = setup();
    go(TOWN, MAP);
    vi.advanceTimersByTime(10_000);
    line(log.s13Start);
    line(log.s13WindowClose);
    line(log.s13Abandon);
    e.pause();
    go(MAP, VOREX_REWARD);
    e.resume();
    expect(reg().map?.active).toBe(false);
    vi.advanceTimersByTime(20_000);
    go(VOREX_REWARD, TOWN);
    expect(ctx(e).accumulatedMapTime).toBe(10_000);
    expect(ctx(e).inMap).toBe(false);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
  });

  it('Vorex reward zone: pause, map -> reward -> town while paused: map time excludes everything after the pause', () => {
    const {e, go} = setup();
    go(TOWN, MAP);
    vi.advanceTimersByTime(7_000);
    e.pause();
    go(MAP, VOREX_REWARD);
    vi.advanceTimersByTime(40_000);
    go(VOREX_REWARD, TOWN);
    e.resume();
    expect(ctx(e).accumulatedMapTime).toBe(7_000);
  });

  it('map -> hub while paused, resume, hub -> town: map time excludes the hub time', () => {
    const {e, go, reg} = setup();
    go(TOWN, MAP);
    vi.advanceTimersByTime(8_000);
    e.pause();
    go(MAP, SANDLORD_HUB);
    e.resume();
    vi.advanceTimersByTime(25_000);     // hub time
    expect(reg().map?.active).toBe(false);
    go(SANDLORD_HUB, TOWN);
    expect(ctx(e).accumulatedMapTime).toBe(8_000);
    expect(ctx(e).mapCount).toBe(1);
    expect(ctx(e).inMap).toBe(false);
    expect(reg().seasonal('sandlord')).toBeNull();
  });

  it('map -> hub while paused, hub -> town while still paused, resume: no stuck trackers', () => {
    const {e, go, reg} = setup();
    go(TOWN, MAP);
    vi.advanceTimersByTime(8_000);
    e.pause();
    go(MAP, SANDLORD_HUB);
    go(SANDLORD_HUB, TOWN);
    e.resume();
    expect(ctx(e).accumulatedMapTime).toBe(8_000);
    expect(reg().map).toBeNull();
    expect(reg().seasonalsSize()).toBe(0);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
  });
});

describe('paused hub run', () => {
  it('pause -> town -> hub -> sub-map -> hub -> town while paused: nothing credited, run finished, mapCount 0', () => {
    const {e, events, go, bag, reg} = setup();
    e.pause();
    go(TOWN, SANDLORD_HUB);
    bag(15);
    go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    bag(20);
    go(SANDLORD_SUB_MAP, SANDLORD_HUB);
    go(SANDLORD_HUB, TOWN);

    expect(ctx(e).mapCount).toBe(0);
    expect(reg().map).toBeNull();
    expect(reg().seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'drop')).toBe(false);
    expect(sessionDrops(e)).toEqual({});
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'sandlord')).toBe(true);

    e.resume();
    expect(reg().seasonalsSize()).toBe(0);   // nothing resurrected
    expect(reg().session?.active).toBe(true);
  });

  it('pause -> town -> hub -> resume -> stop mid-hub: stops cleanly, session total emitted', () => {
    const {e, events, go, bag} = setup();
    e.pause();
    go(TOWN, SANDLORD_HUB);
    e.resume();
    bag(14);
    e.stop();
    expect(ctx(e).phase).toBe('idle');
    const fin = events.filter(ev => ev.type === 'tracker_finished' && ev.sessionMeta);
    expect(fin).toHaveLength(1);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });

  it('hub run entered while paused, session paused again after resume: freezes and thaws again', () => {
    const {e, go, reg} = setup();
    e.pause();
    go(TOWN, SANDLORD_HUB);
    e.resume();
    expect(reg().seasonal('sandlord')?.active).toBe(true);
    e.pause();
    expect(reg().seasonal('sandlord')?.active).toBe(false);
    e.resume();
    expect(reg().seasonal('sandlord')?.active).toBe(true);
  });

  it('hub run entered while paused: repeat hub entry (hub -> hub) does not double-start', () => {
    const {e, go, reg, events} = setup();
    e.pause();
    go(TOWN, SANDLORD_HUB);
    go(SANDLORD_HUB, SANDLORD_HUB);
    e.resume();
    expect(events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'sandlord')).toHaveLength(1);
    expect(reg().seasonal('sandlord')?.active).toBe(true);
    expect(ctx(e).mapCount).toBe(0);
  });

  it('a hub entered unpaused then paused/resumed mid-hub credits only after the resume', () => {
    const {e, go, bag} = setup();
    go(TOWN, SANDLORD_HUB);
    bag(12);                            // +2
    e.pause();
    bag(20);                            // +8 while paused: not credited
    e.resume();
    bag(23);                            // +3
    expect(sessionDrops(e)).toEqual({[ITEM]: 5});
    expect(dropsBySource(e)).toEqual({sandlord: {[ITEM]: 5}});
  });
});

describe('interlude claimed while paused, then the run ends in town', () => {
  it.each([
    ['arcana fight',  ARCANA_FIGHT],
    ['tartarus fight', TARTARUS_FIGHT],
    ['vorex reward',  VOREX_REWARD],
  ])('pause, map -> %s -> town while paused, resume: no marker, no map, nothing stuck', (_name, scene) => {
    const {e, go, reg} = setup();
    go(TOWN, MAP);
    vi.advanceTimersByTime(6_000);
    e.pause();
    go(MAP, scene);
    go(scene, TOWN);
    e.resume();
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
    expect(reg().map).toBeNull();
    expect(ctx(e).accumulatedMapTime).toBe(6_000);
    expect(reg().seasonalsSize()).toBe(0);
    expect(reg().session?.active).toBe(true);
  });
});
