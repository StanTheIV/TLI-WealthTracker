/**
 * Adversarial unit tests (step 1.6): production-chain sequences and seeded
 * random walks, each checked with the unit invariant (src/test/unit-invariant),
 * the OwnerWatcher, and the rows SessionPersistence saves from the units.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {DbSessionMap} from '@/shared/contracts/db';
import {SqliteSessionStore} from '@/main/db/session-store';
import {SessionPersistence} from '@/main/session-persistence';
import {OwnerWatcher} from '@/test/owner-invariant';
import {checkUnits, countUnitRuns} from '@/test/unit-invariant';
import {unitsOf} from '@/test/unit-events';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {
  ARCANA_FIGHT, boot, createDispatcher, createEngineWithEmit, ctx, feed, log, MAP, SANDLORD_HUB,
  TARTARUS_FIGHT, TOWN, VOREX_REWARD,
} from './seasonal-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const LOOT     = 800;
const MATERIAL = 100;
const MAP2     = '/Game/Art/Maps/S5_Boss2';

function rig() {
  const events: EngineEvent[] = [];
  const resets: number[] = [];
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  const persistence = new SessionPersistence(
    {sessionId: 's1', sessionName: 'adv', isOverride: false},
    {store, readPrices: () => ({})},
  );
  let saved: string | null = null;
  let e!: Engine;
  const w = new OwnerWatcher({writer: () => ctx(e).registry.writer(), store: true});
  e = createEngineWithEmit(ev => {
    events.push(ev);
    w.onEmit(ev);
    const out = persistence.onEngineEvent(ev);
    if (out?.savedId) saved = out.savedId;
  });
  const d = createDispatcher();
  boot(d, e, [{slotId: 1, itemId: LOOT, quantity: 0}, {slotId: 2, itemId: MATERIAL, quantity: 10}]);
  let lootTotal = 0;
  let scene = TOWN;
  const o = {
    e, d, events, w, store,
    line:  (l: string) => feed(d, e, l),
    go:    (to: string) => { feed(d, e, log.zoneTransition(scene, to)); scene = to; },
    drop:  (n = 1) => { lootTotal += n; feed(d, e, log.bagUpdate(1, LOOT, lootTotal)); },
    spend: () => feed(d, e, log.bagUpdate(2, MATERIAL, 7)),
    adv:   (ms: number) => vi.advanceTimersByTime(ms),
    reset: () => { resets.push(events.length); persistence.discard(); e.reset(); },
    stop:  () => e.stop(),
    saved: () => saved,
    rows:  (): DbSessionMap[] => (saved ? store.getRows(saved) : []),
    resets,
    /** Everything the engine and persistence must uphold after the run. */
    verify: () => {
      expect(checkUnits(events, {resets})).toEqual([]);
      expect(w.violations).toEqual([]);
      if (saved) checkRows(o.rows(), events.slice(resets.length ? resets[resets.length - 1] : 0));
    },
  };
  return o;
}
type Rig = ReturnType<typeof rig>;

function checkRows(rows: DbSessionMap[], events: EngineEvent[]): void {
  expect(rows).toHaveLength(countUnitRuns(events));
  const primaries = rows.filter(r => r.parentMapIndex === null);
  expect(primaries.map(r => r.mapIndex)).toEqual(primaries.map((_, i) => i + 1));
  const byIndex = new Map(primaries.map(r => [r.mapIndex, r]));
  for (const r of rows) {
    expect(r.endedAt).toBeGreaterThanOrEqual(r.startedAt + r.duration);
    expect(r.endedAt).toBeGreaterThanOrEqual(r.startedAt);
    if (r.parentMapIndex !== null) {
      expect(r.mapIndex).toBe(r.parentMapIndex);
      const p = byIndex.get(r.parentMapIndex)!;
      expect(p).toBeDefined();
      expect(p.seasonalType).toBeNull();                 // overlaps only ever hang off a map
      expect(r.startedAt).toBeLessThanOrEqual(p.endedAt);
      expect(r.endedAt).toBeLessThanOrEqual(p.endedAt);
    }
  }
}

const openTartarus = (o: Rig) => {
  o.line(log.s16BoardOpen); o.line(log.s16SuppressRow); o.line(log.s16Suppress); o.line(log.s16BoardClose); o.line(log.s16BoardCloseTip);
};

type Play = (o: Rig) => void;
/** Each sequence ends back in town (or is cut off as named). */
const SEQUENCES: Array<[string, Play]> = [
  ['map with 0 children', o => { o.go(MAP); o.adv(30_000); o.drop(3); o.go(TOWN); }],
  ['map with 1 child (lunaria)', o => { o.go(MAP); o.line(log.s14Strum); o.drop(); o.adv(40_000); o.go(TOWN); }],
  ['map with 3 children', o => {
    o.go(MAP); o.line(log.s14Strum); o.drop(); o.line(log.s10Wave); o.drop();
    o.line(log.s9Minigame); o.line(log.s9Close); o.adv(40_000); o.go(TOWN);
  }],
  ['child finishing early (arcana fight back to the map)', o => {
    o.go(MAP); o.line(log.s9Minigame); o.go(ARCANA_FIGHT); o.adv(20_000); o.drop(2); o.go(MAP); o.adv(20_000); o.go(TOWN);
  }],
  ['child finishing at town (panel left open)', o => { o.go(MAP); o.line(log.s9Minigame); o.adv(30_000); o.go(TOWN); }],
  ['arcana interlude straight to town', o => { o.go(MAP); o.line(log.s9Minigame); o.go(ARCANA_FIGHT); o.adv(9_000); o.go(TOWN); }],
  ['vorex from the map', o => { o.go(MAP); o.line(log.s13Start); o.go(VOREX_REWARD); o.adv(9_000); o.drop(); o.go(MAP); o.adv(5_000); o.go(TOWN); }],
  ['vorex from the map straight to town', o => { o.go(MAP); o.line(log.s13Start); o.go(VOREX_REWARD); o.adv(9_000); o.go(TOWN); }],
  ['tartarus fight from a map', o => { o.go(MAP); openTartarus(o); o.go(TARTARUS_FIGHT); o.adv(9_000); o.go(MAP); o.go(TOWN); }],
  ['tartarus fight from town', o => { openTartarus(o); o.go(TARTARUS_FIGHT); o.adv(9_000); o.go(TOWN); }],
  ['hub direct from a map', o => { o.go(MAP); o.adv(10_000); o.go(SANDLORD_HUB); o.adv(10_000); o.drop(3); o.go(TOWN); }],
  ['hub direct from a map, back to the map', o => { o.go(MAP); o.go(SANDLORD_HUB); o.adv(10_000); o.go(MAP); o.adv(10_000); o.go(TOWN); }],
  ['hub from town', o => { o.go(SANDLORD_HUB); o.adv(10_000); o.go(TOWN); }],
  ['town panel opened, backed out, reopened in a map', o => {
    o.line(log.s9Minigame); o.line(log.s9Close); o.go(MAP); o.adv(5_000); o.line(log.s9Minigame); o.line(log.s9Close); o.adv(5_000); o.go(TOWN);
  }],
  ['town panel backed out and never reopened', o => { o.line(log.s9Minigame); o.line(log.s9Close); o.go(MAP); o.adv(5_000); o.go(TOWN); }],
  ['town panel left open into a map', o => { o.line(log.s9Minigame); o.go(MAP); o.adv(5_000); o.go(TOWN); }],
  ['pause in town, map entered paused, resume in the map', o => {
    o.e.pause(); o.go(MAP); o.adv(5_000); o.e.resume(); o.line(log.s14Strum); o.adv(5_000); o.go(TOWN);
  }],
  ['pause and resume around a child in the map', o => {
    o.go(MAP); o.line(log.s14Strum); o.e.pause(); o.adv(20_000); o.e.resume(); o.line(log.s10Wave); o.adv(5_000); o.go(TOWN);
  }],
  ['pause across an arcana interlude', o => {
    o.go(MAP); o.line(log.s9Minigame); o.go(ARCANA_FIGHT); o.e.pause(); o.adv(10_000); o.e.resume(); o.go(MAP); o.go(TOWN);
  }],
  ['two maps in a row', o => {
    o.go(MAP); o.line(log.s14Strum); o.go(TOWN); o.go(MAP); o.line(log.s10Wave); o.go(TOWN);
  }],
  ['map to map without town', o => { o.go(MAP); o.line(log.s14Strum); o.adv(5_000); o.go(MAP2); o.adv(5_000); o.go(TOWN); }],
  ['entry cost with a child', o => { o.spend(); o.go(MAP); o.line(log.s14Strum); o.drop(); o.go(TOWN); }],
  ['clockwork podium', o => { o.go(MAP); o.line(log.s7Podium); o.adv(5_000); o.go(TOWN); }],
];

describe('production-chain sequences', () => {
  it.each(SEQUENCES)('%s: units, owners and rows hold, with and without a stop', (_name, play) => {
    for (const stopAtEnd of [false, true]) {
      const o = rig();
      play(o);
      o.adv(31_000);
      o.drop();
      if (stopAtEnd) o.stop();
      o.verify();
      if (stopAtEnd) expect(o.saved()).not.toBeNull();
    }
  });

  it('stop mid-map with finished and live children: finished promoted, live dropped, none after the session', () => {
    const o = rig();
    o.go(MAP);
    o.line(log.s9Minigame); o.go(ARCANA_FIGHT); o.adv(5_000); o.go(MAP);   // arcana finished
    o.line(log.s14Strum); o.line(log.s10Wave);                            // lunaria + sandlord live
    o.adv(31_000); o.drop();
    o.stop();
    o.verify();
    expect(unitsOf(o.events).map(u => u.tracker.seasonalType)).toEqual(['arcana']);
    expect(o.rows().map(r => r.seasonalType)).toEqual(['arcana']);
  });

  it('stop mid-map with nothing finished emits no unit and saves no rows', () => {
    const o = rig();
    o.go(MAP); o.line(log.s14Strum); o.adv(31_000); o.drop();
    o.stop();
    o.verify();
    expect(unitsOf(o.events)).toEqual([]);
    expect(o.rows()).toEqual([]);
  });

  it('reset mid-map: no unit from the discarded run, the rebuilt map saves clean', () => {
    const o = rig();
    o.go(MAP); o.line(log.s14Strum); o.line(log.s9Minigame); o.go(ARCANA_FIGHT); o.adv(5_000); o.go(MAP);
    o.reset();
    expect(unitsOf(o.events)).toEqual([]);
    o.adv(10_000); o.line(log.s10Wave); o.drop(); o.adv(31_000);
    o.go(TOWN);
    o.stop();
    o.verify();
    expect(o.rows().map(r => [r.mapIndex, r.parentMapIndex, r.seasonalType])).toEqual([[1, null, null], [1, 1, 'sandlord']]);
  });

  it('reset in town: no unit, later map is index 1', () => {
    const o = rig();
    o.line(log.s9Minigame); o.line(log.s9Close);
    o.reset();
    o.go(MAP); o.drop(); o.adv(31_000); o.go(TOWN);
    o.stop();
    o.verify();
    expect(o.rows().map(r => [r.mapIndex, r.seasonalType])).toEqual([[1, null]]);
  });

  it('a never-frozen map row has endedAt exactly startedAt + duration; a frozen one later', () => {
    const o = rig();
    o.go(MAP); o.adv(30_000); o.drop(); o.go(TOWN);
    o.go(MAP); o.line(log.s9Minigame); o.go(ARCANA_FIGHT); o.adv(20_000); o.go(MAP); o.adv(5_000); o.go(TOWN);
    o.stop();
    o.verify();
    const [plain, frozen] = o.rows().filter(r => r.seasonalType === null);
    expect(plain.endedAt).toBe(plain.startedAt + plain.duration);
    expect(frozen.endedAt).toBeGreaterThan(frozen.startedAt + frozen.duration);
  });
});

// ---------------------------------------------------------------------------
// Seeded random walks
// ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCENES = [TOWN, MAP, MAP2, ARCANA_FIGHT, VOREX_REWARD, SANDLORD_HUB, TARTARUS_FIGHT];
const WAITS  = [0, 500, 5_000, 10_100, 61_000];

function step(o: Rig, r: () => number, sceneOf: () => string): void {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const n = r();
  if (n < 0.30)      o.go(pick(SCENES.filter(s => s !== sceneOf())));
  else if (n < 0.40) o.line(pick([log.s9Minigame, log.s9Close, log.s9Fight]));
  else if (n < 0.48) o.line(log.s14Strum);
  else if (n < 0.54) o.line(pick([log.s10Wave, log.s10Quench, log.s10Land]));
  else if (n < 0.60) o.line(pick([log.s13Start, log.s13WindowClose, log.s13Abandon]));
  else if (n < 0.64) openTartarus(o);
  else if (n < 0.68) o.line(pick([log.s7Podium, log.s7Turnin]));
  else if (n < 0.74) o.drop(1 + Math.floor(r() * 3));
  else if (n < 0.80) o.spend();
  else if (n < 0.86) o.e.pause();
  else if (n < 0.92) o.e.resume();
  else if (n < 0.94) { if (ctx(o.e).phase === 'tracking') o.reset(); }
  else               o.adv(pick(WAITS));
}

const coverage = {standalone: 0, maps: 0, overlaps: 0, saved: 0, resets: 0};

describe('seeded random walks', () => {
  const SEEDS = Array.from({length: 150}, (_, i) => i + 1);

  it.each(SEEDS)('seed %i keeps every unit, owner and row invariant', (seed) => {
    const r = prng(seed);
    const o = rig();
    // Track the scene through the zone events the engine itself saw.
    const sceneOf = () => lastScene;
    let lastScene = TOWN;
    const go = o.go;
    o.go = (to: string) => { go(to); lastScene = to; };
    const len = 25 + Math.floor(r() * 40);
    for (let i = 0; i < len; i++) {
      step(o, r, sceneOf);
      if (r() < 0.3) o.adv(WAITS[Math.floor(r() * WAITS.length)]);
    }
    if (r() < 0.7) o.go(TOWN);
    o.adv(31_000);
    o.drop();
    if (r() < 0.8) o.stop();
    expect(checkUnits(o.events, {resets: o.resets})).toEqual([]);
    expect(o.w.violations).toEqual([]);
    o.w.checkSet(`seed ${seed}`);
    for (const u of unitsOf(o.events)) {
      if (u.tracker.kind === 'map') { coverage.maps++; coverage.overlaps += u.overlaps.length; } else coverage.standalone++;
    }
    if (o.saved()) coverage.saved++;
    coverage.resets += o.resets.length;
    if (o.saved()) checkRows(o.rows(), o.events.slice(o.resets.length ? o.resets[o.resets.length - 1] : 0));
  });
});

describe('walk coverage', () => {
  it('the walks produced maps, overlaps, standalone units, saves and resets', () => {
    expect(coverage.maps).toBeGreaterThan(50);
    expect(coverage.overlaps).toBeGreaterThan(20);
    expect(coverage.standalone).toBeGreaterThan(20);
    expect(coverage.saved).toBeGreaterThan(50);
    expect(coverage.resets).toBeGreaterThan(10);
  });
});

describe('the checker itself', () => {
  function sample(): EngineEvent[] {
    const o = rig();
    o.go(SANDLORD_HUB); o.adv(3_000); o.go(TOWN);
    o.go(MAP); o.line(log.s14Strum); o.drop(); o.go(ARCANA_FIGHT);
    o.line(log.s9Minigame); o.go(TOWN);
    o.line(log.s9Minigame); o.go(MAP2); o.go(TOWN);
    o.adv(31_000); o.drop(); o.stop();
    return o.events;
  }
  const idx = (evs: EngineEvent[], f: (e: EngineEvent) => boolean) => evs.findIndex(f);
  const isMapUnit = (e: EngineEvent) => e.type === 'unit_finished' && e.tracker.kind === 'map';

  it('passes the untampered stream with at least one overlap', () => {
    const evs = sample();
    expect(checkUnits(evs)).toEqual([]);
    expect(unitsOf(evs).some(u => u.overlaps.length > 0)).toBe(true);
  });

  it('flags a dropped map unit', () => {
    const evs = sample();
    evs.splice(idx(evs, isMapUnit), 1);
    expect(checkUnits(evs).length).toBeGreaterThan(0);
  });

  it('flags a duplicated map unit', () => {
    const evs = sample();
    const i = idx(evs, isMapUnit);
    evs.splice(i, 0, evs[i]);
    expect(checkUnits(evs).length).toBeGreaterThan(0);
  });

  it('flags a unit after the session finish', () => {
    const evs = sample();
    const s = idx(evs, e => e.type === 'tracker_finished' && e.tracker.kind === 'session');
    const u = evs.find(e => e.type === 'unit_finished')!;
    evs.splice(s + 1, 0, u);
    expect(checkUnits(evs).length).toBeGreaterThan(0);
  });

  it('flags an overlap stamped after its map', () => {
    const evs = sample();
    const i = idx(evs, e => isMapUnit(e) && e.type === 'unit_finished' && e.overlaps.length > 0);
    const u = evs[i] as Extract<EngineEvent, {type: 'unit_finished'}>;
    evs[i] = {...u, overlaps: u.overlaps.map(o => ({...o, timestamp: u.timestamp + 1}))};
    expect(checkUnits(evs).length).toBeGreaterThan(0);
  });

  it('flags a seasonal finish no unit carries', () => {
    const evs = sample();
    const i = idx(evs, e => e.type === 'unit_finished' && e.tracker.kind === 'seasonal');
    evs.splice(i, 1);
    expect(checkUnits(evs).length).toBeGreaterThan(0);
  });

  it('flags an overlap carried twice', () => {
    const evs = sample();
    const i = idx(evs, e => isMapUnit(e) && e.type === 'unit_finished' && e.overlaps.length > 0);
    const u = evs[i] as Extract<EngineEvent, {type: 'unit_finished'}>;
    evs[i] = {...u, overlaps: [...u.overlaps, ...u.overlaps]};
    expect(checkUnits(evs).length).toBeGreaterThan(0);
  });
});
