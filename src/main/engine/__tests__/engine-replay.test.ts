/**
 * 4.2a: `Engine.getState()` replays the engine's UI-visible state as a list of
 * ordinary EngineEvents. Fed to a FRESH engineStore through
 * `applySnapshot({seq, events})` it must reproduce the live store.
 *
 * The equivalence suite drives real runs with the lockstep rig (every engine
 * event goes into the live store) and, after EVERY operation, builds a fresh
 * store from the replay and compares it with the live one (normalised: no
 * `feed`, `sessionsVersion`, `*ReceivedAt` values or `dismissedMaterials`;
 * every elapsed compared as DISPLAYED; `lootWindowDeadlines` compared exactly).
 *
 * `Engine.getState` and `applySnapshot` do not exist yet — reached through
 * local interfaces so the file typechecks; the cases fail at runtime until
 * they are implemented.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {EngineEvent, SeasonalType, TrackerSnapshot} from '@/shared/contracts/engine';
import type {Engine} from '@/main/engine/engine';
import {useEngineStore, selectRunStatus} from '@/state/engineStore';
import {elapsedAt} from '@/state/clock';
import {parseSettings} from '@/shared/settings';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TARTARUS_FIGHT, TEST_IDENTITY, TOWN, VOREX_REWARD,
  createDispatcher, createEngineWithEmit, ctx, feed, log,
} from './seasonal-fixtures';
import {beginSession, completeInit, type SeedData} from './identity-fixtures';

// -- APIs under test (absent today) -----------------------------------------

interface ReplayEngine { getState(): EngineEvent[] }
interface SnapshotStore {
  applySnapshot(snapshot: {seq: number; events: EngineEvent[]}): void;
  lastSeq: number;
}
const replayOf  = (e: Engine): EngineEvent[] => (e as unknown as ReplayEngine).getState();
const snapshotApi = () => useEngineStore.getState() as unknown as SnapshotStore;

const store = () => useEngineStore.getState();

const LOOT     = 800;
const MATERIAL = 100;
const INV      = [{slotId: 1, itemId: LOOT, quantity: 0}, {slotId: 2, itemId: MATERIAL, quantity: 10}];

// -- normalisation ----------------------------------------------------------

/** The elapsed the renderer DISPLAYS (useTrackerElapsed): a running tracker's
 *  snapshot extrapolated from when it arrived, a frozen one's as is. The
 *  replay's snapshots are taken now, the live ones whenever last emitted —
 *  what the user sees must agree all the same. */
const shown = (elapsed: number, receivedAt: number | null, running: boolean) =>
  elapsedAt(elapsed, receivedAt, Date.now(), running);

/** The comparable view of the store. */
function norm(s: ReturnType<typeof useEngineStore.getState>) {
  const dismissed = s.dismissedMaterials;
  const running   = selectRunStatus(s) === 'running';
  const tracker   = (t: TrackerSnapshot | null, receivedAt: number | null) =>
    t && {...t, elapsed: shown(t.elapsed, receivedAt, running && t.active)};
  return {
    phase:               s.phase,
    runStatus:           selectRunStatus(s),
    drops:               s.drops,
    sessionSpent:        s.sessionSpent,
    mapCount:            s.mapCount,
    currentZone:         s.currentZone,
    mapTracker:          tracker(s.mapTracker, s.mapTrackerReceivedAt),
    mapTrackerStamped:   s.mapTrackerReceivedAt !== null,
    seasonalTrackers:    [...s.seasonalTrackers]
      .map(([k, v]) => [k, tracker(v, s.seasonalTrackersReceivedAt.get(k) ?? null)] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
    seasonalStamped:     [...s.seasonalTrackersReceivedAt.keys()].sort(),
    sessionStatus:       s.sessionStatus,
    sessionElapsed:      shown(s.sessionElapsed, s.sessionReceivedAt, running),
    sessionStamped:      s.sessionReceivedAt !== null,
    accumulatedMapTime:  s.accumulatedMapTime,
    activeSessionId:     s.activeSessionId,
    activeSessionName:   s.activeSessionName,
    // A dismissed row stays in the live list (hidden by `dismissedMaterials`);
    // the engine's replay omits it.
    lowStockWarnings:    s.lowStockWarnings.filter(w => !dismissed.has(w.itemId)),
    lootWindowDeadlines: [...s.lootWindowDeadlines].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

/** Build a fresh store from `events` and read it, leaving the live store intact. */
function viaReplay(events: EngineEvent[]) {
  const saved = useEngineStore.getState();
  try {
    snapshotApi().applySnapshot({seq: 0, events});
    return norm(useEngineStore.getState());
  } finally {
    useEngineStore.setState(saved, true);
  }
}

// -- the lockstep rig -------------------------------------------------------

const dismissMaterial = vi.fn<(id: number) => void>();

function rig(inv = INV) {
  const events: EngineEvent[] = [];
  // The store gets what the wire carries: never unit_finished.
  const e =createEngineWithEmit(ev => { events.push(ev); if (ev.type !== 'unit_finished') store().handleEvent(ev); });
  const d = createDispatcher();
  let total = 0;

  /** THE equivalence helper — run after every operation. */
  const eq = (label: string) => {
    const replay = replayOf(e);
    expect(viaReplay(replay), label).toEqual(norm(store()));
  };
  const step = (label: string, fn: () => void) => { fn(); eq(label); };

  return {
    e, d, events, eq,
    start:   (opts: {loaded?: SeedData} = {}) => step('start', () => beginSession(e, opts)),
    init:    () => step('init', () => completeInit(d, e, inv)),
    line:    (l: string, label?: string) => step(label ?? l.slice(0, 48), () => feed(d, e, l)),
    go:      (a: string, b: string) => step(`go ${b.slice(-22)}`, () => feed(d, e, log.zoneTransition(a, b))),
    drop:    (n = 1) => step('drop', () => { total += n; feed(d, e, log.bagUpdate(1, LOOT, total)); }),
    bag:     (slot: number, item: number, qty: number) => step(`bag ${item}=${qty}`, () => feed(d, e, log.bagUpdate(slot, item, qty))),
    adv:     (ms: number) => step(`adv ${ms}`, () => vi.advanceTimersByTime(ms)),
    pause:   () => step('pause',  () => e.pause()),
    resume:  () => step('resume', () => e.resume()),
    reset:   () => step('reset',  () => e.reset(TEST_IDENTITY)),
    stop:    () => step('stop',   () => e.stop()),
    dismiss: (id: number) => step(`dismiss ${id}`, () => { e.dismissMaterial(id); store().dismissLowStockItem(id); }),
    configure: () => e.configure(parseSettings({lowStockThreshold: '1'})),
    replay:  () => replayOf(e),
    types:   () => replayOf(e).map(ev => ev.type),
    deadlines: (): Array<[SeasonalType, number]> => [...store().lootWindowDeadlines],
  };
}
type Rig = ReturnType<typeof rig>;

/** Start + init + into a map. */
function inMap(inv = INV): Rig {
  const r = rig(inv);
  r.start(); r.init(); r.go(TOWN, MAP);
  return r;
}

const count = (evs: EngineEvent[], t: string) => evs.filter(e => e.type === t).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
  store().reset();
  dismissMaterial.mockReset();
  vi.stubGlobal('window', {electronAPI: {engine: {dismissMaterial}}});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('replay == live store: run states', () => {
  it('idle', () => {
    const r = rig();
    r.eq('idle');
    expect(r.replay()).toEqual([]);
  });

  it('initializing', () => {
    const r = rig();
    r.start();
    expect(r.types()).toEqual(['init_started']);
    r.line(log.bagInit(1, LOOT, 0), 'bag dump in progress');
    // The zone is announced while initializing too; nothing else is.
    r.go(TOWN, MAP);
    expect(r.types()).toEqual(['init_started', 'zone_change']);
  });

  it('tracking in town', () => {
    const r = rig();
    r.start(); r.init();
    r.adv(1_000);
    r.drop(2);
  });

  it('in a map with an entry cost', () => {
    const r = rig();
    r.start(); r.init();
    r.bag(2, MATERIAL, 7); // 3 spent in town
    r.go(TOWN, MAP);
    expect(store().sessionSpent).toEqual({[MATERIAL]: 3}); // scenario is not vacuous
    r.drop(2);
    r.go(MAP, TOWN);
    r.bag(2, MATERIAL, 4);
    r.go(TOWN, MAP);
    r.drop(1);
    r.go(MAP, TOWN);
  });

  it('after stop: idle, replay is []', () => {
    const r = inMap();
    r.drop(1);
    r.pause();
    r.e.stop();
    expect(r.replay()).toEqual([]);
    // The live store keeps the last run's drops/zone on screen; the run state is what must agree.
    const fresh = viaReplay([]);
    const live  = norm(store());
    for (const k of ['phase', 'runStatus', 'sessionStatus', 'sessionElapsed', 'sessionStamped', 'mapTracker', 'mapTrackerStamped',
      'seasonalTrackers', 'seasonalStamped', 'accumulatedMapTime', 'activeSessionId', 'activeSessionName'] as const) {
      expect(live[k], k).toEqual(fresh[k]);
    }
    expect(live.runStatus).toBe('idle');
  });

  it('stop during initializing: [] again', () => {
    const r = rig();
    r.start();
    r.e.stop();
    expect(r.replay()).toEqual([]);
  });
});

describe('replay == live store: mechanics', () => {
  it('Arcana fight: the map is frozen', () => {
    const r = inMap();
    r.drop(1);
    r.line(log.s9Minigame, 'arcana panel');
    expect(ctx(r.e).registry.map?.active).toBe(false);
    r.drop(2);
    r.adv(4_000);
    r.drop(1);
    r.line(log.s9Close, 'arcana close');
    r.drop(1);
    r.go(MAP, TOWN);
  });

  it('Arcana fight scene from town', () => {
    const r = rig();
    r.start(); r.init();
    r.line(log.s9Minigame, 'arcana panel');
    r.go(TOWN, ARCANA_FIGHT);
    r.adv(3_000);
    r.drop(2);
    r.go(ARCANA_FIGHT, TOWN);
  });

  it('Vorex window: open, close, reopen, abandon', () => {
    const r = inMap();
    r.line(log.s13Start, 'vorex open');
    expect(ctx(r.e).registry.seasonal('vorex')).not.toBeNull();
    r.drop(1);
    r.line(log.s13WindowClose, 'vorex window close');
    r.drop(1);
    r.line(log.s13Start, 'vorex reopen');
    r.drop(1);
    r.line(log.s13Abandon, 'vorex abandon');
    r.go(MAP, VOREX_REWARD);
    r.go(VOREX_REWARD, TOWN);
  });

  it('Tartarus: board, checkout, fight scene', () => {
    const r = rig();
    r.start(); r.init();
    for (const l of [log.s16BoardOpenSettled, log.s16Ignore, log.s16BoardClose, log.s16BoardCloseTip]) r.line(l);
    r.line(log.s16BoardOpen, 'tartarus board');
    expect(ctx(r.e).registry.seasonal('tartarus')).not.toBeNull();
    r.adv(20_000);
    for (const l of [log.s16SuppressRow, log.s16Suppress, log.s16BoardClose, log.s16BoardCloseTip]) r.line(l);
    r.go(TOWN, TARTARUS_FIGHT);
    r.adv(10_000);
    r.drop(3);
    r.go(TARTARUS_FIGHT, TOWN);
  });

  it('Sandlord hub and sub-map', () => {
    const r = rig();
    r.start(); r.init();
    r.go(TOWN, SANDLORD_HUB);
    expect(ctx(r.e).registry.seasonal('sandlord')).not.toBeNull();
    r.drop(1);
    r.adv(2_000);
    r.go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    r.drop(1);
    r.go(SANDLORD_SUB_MAP, TOWN);
  });

  it('Sandlord tile with a running wave window', () => {
    const r = inMap();
    r.line(log.s10Wave, 'sandlord wave');
    expect(r.deadlines().map(([t]) => t)).toEqual(['sandlord']);
    r.drop(1);
    r.adv(3_000);
    r.line(log.s10Wave, 'second wave');
    r.drop(2);
    r.adv(11_000); // window expired -> paused
    r.go(MAP, TOWN);
  });

  it('Carjack: loot window running', () => {
    const r = inMap();
    r.line(log.s11Start, 'carjack start');
    r.drop(1);
    r.line(log.s11End, 'carjack end');
    expect(r.deadlines().map(([t]) => t)).toEqual(['carjack']);
    r.adv(2_000);
    r.drop(1);
    r.adv(5_000); // window expires, tracker finishes
    r.go(MAP, TOWN);
  });

  it('Afterlight: loot window running', () => {
    const r = inMap();
    r.line(log.afterlightStart, 'afterlight start');
    r.line(log.afterlightWave, 'afterlight wave');
    r.drop(1);
    r.line(log.afterlightEnd, 'afterlight end');
    expect(r.deadlines().map(([t]) => t)).toEqual(['afterlight']);
    r.adv(1_000);
    r.drop(1);
    r.go(MAP, TOWN);
  });

  it('Lunaria dormant between strum episodes', () => {
    const r = inMap();
    r.line(log.s14Strum, 'strum');
    r.drop(1);
    r.adv(5_100); // loot timer expiry: tracker paused, not finished
    expect(ctx(r.e).registry.seasonal('lunaria')?.active).toBe(false);
    r.drop(1);
    r.line(log.s14Strum, 'strum again');
    r.adv(5_100);
    r.go(MAP, TOWN);
  });

  it('concurrent seasonals with an owner flip', () => {
    const r = inMap();
    r.line(log.s12Entry, 'overrealm entry');
    r.drop(1);
    r.line(log.s14Strum, 'lunaria strum'); // lunaria owns
    r.drop(2);
    r.adv(5_100);                          // lunaria dormant -> overrealm owns
    r.drop(1);
    r.line(log.s12Exit, 'overrealm exit');
    r.drop(1);
    r.adv(5_100);                          // overrealm finishes
    r.drop(2);
    r.go(MAP, TOWN);
  });
});

describe('replay == live store: pause, reset, continue, low stock', () => {
  it('pause with a frozen window: no deadline in either store; resume brings it back', () => {
    const r = inMap();
    r.line(log.s11Start, 'carjack start');
    r.line(log.s11End, 'carjack end');
    r.adv(2_000);
    expect(r.deadlines()).toHaveLength(1);
    const [[, before]] = r.deadlines();

    r.pause();
    expect(r.deadlines()).toEqual([]);
    expect(r.replay().some(ev => ev.type === 'loot_window_started')).toBe(false);
    r.adv(30_000);
    r.drop(1); // a drop accepted while paused
    expect(r.deadlines()).toEqual([]);

    r.resume();
    expect(r.deadlines()).toHaveLength(1);
    const [[type, after]] = r.deadlines();
    expect(type).toBe('carjack');
    expect(after).toBeGreaterThan(Date.now()); // the remaining time, not a stale past deadline
    expect(after).toBeLessThanOrEqual(before + 30_000 + 1_000);
    const started = r.replay().filter(ev => ev.type === 'loot_window_started');
    expect(started).toHaveLength(1);
    expect((started[0] as Extract<EngineEvent, {type: 'loot_window_started'}>).deadline).toBe(after);
  });

  it('pause and resume in town, in a map, with a concurrent seasonal', () => {
    const r = rig();
    r.start(); r.init();
    r.pause(); r.resume();
    r.go(TOWN, MAP);
    r.line(log.s12Entry, 'overrealm');
    r.line(log.s14Strum, 'lunaria');
    r.drop(1);
    r.pause();
    r.go(MAP, TOWN);
    r.resume();
  });

  it('reset while running', () => {
    const r = inMap();
    r.drop(3);
    r.line(log.s11Start, 'carjack start');
    r.reset();
    r.drop(1);
    r.go(MAP, TOWN);
  });

  it('reset while paused stays paused', () => {
    const r = inMap();
    r.drop(3);
    r.pause();
    r.reset();
    expect(selectRunStatus(store())).toBe('paused');
    r.resume();
  });

  it('a continued session: name and `continued`', () => {
    const r = rig();
    const loaded: SeedData = {sessionId: 'old', name: 'Old run', drops: {}, dropsBySource: {}, spent: {}, totalTime: 90, mapTime: 10, mapCount: 2};
    r.start({loaded});
    r.init();
    expect(store().activeSessionName).toBe('Old run');
    const meta = r.replay().find((ev): ev is Extract<EngineEvent, {type: 'tracker_started'}> => ev.type === 'tracker_started' && ev.tracker.kind === 'session')!.sessionMeta!;
    expect(meta).toMatchObject({sessionId: 'old', name: 'Old run', continued: true, mapCount: 2});
    expect(meta.mapTime).toBe(ctx(r.e).accumulatedMapTime);
    r.go(TOWN, MAP);
    r.drop(1);
    r.go(MAP, TOWN);
  });

  it('a fresh session is not `continued`', () => {
    const r = rig();
    r.start(); r.init();
    const meta = r.replay().find((ev): ev is Extract<EngineEvent, {type: 'tracker_started'}> => ev.type === 'tracker_started' && ev.tracker.kind === 'session')!.sessionMeta!;
    expect(meta).toMatchObject({sessionId: TEST_IDENTITY.sessionId, continued: false, mapCount: 0});
    expect(store().activeSessionName).toBeNull();
  });

  /** Item 100 spent on two consecutive maps and now at qty <= threshold. */
  function lowStock(): Rig {
    const r = rig([{slotId: 1, itemId: MATERIAL, quantity: 4}]);
    r.configure();
    r.start(); r.init();
    for (const qty of [3, 2, 1]) {
      r.bag(1, MATERIAL, qty);
      r.go(TOWN, MAP);
      if (qty !== 1) r.go(MAP, TOWN);
    }
    return r;
  }

  it('low-stock warning present', () => {
    const r = lowStock();
    expect(store().lowStockWarnings).toEqual([{itemId: MATERIAL, quantity: 1}]);
    const w = r.replay().filter((ev): ev is Extract<EngineEvent, {type: 'map_material_warning'}> => ev.type === 'map_material_warning');
    expect(w).toHaveLength(1);
    expect(w[0].items).toEqual([{itemId: MATERIAL, quantity: 1}]);
    r.go(MAP, TOWN);
  });

  it('low-stock warning dismissed: the replay does not resurrect it', () => {
    const r = lowStock();
    r.dismiss(MATERIAL);
    expect(r.replay().some(ev => ev.type === 'map_material_warning' && ev.items.length > 0)).toBe(false);
    expect(dismissMaterial).toHaveBeenCalledWith(MATERIAL);
    r.go(MAP, TOWN);
  });

  it('no warnings -> no map_material_warning in the replay', () => {
    const r = inMap();
    expect(r.types()).not.toContain('map_material_warning');
  });
});

describe('replay shape', () => {
  const EXCLUDED = ['drop', 'new_item', 'session_saved', 'price_update', 'wealth_recorded', 'unit_finished', 'engine_stopped', 'error'];

  /** A busy mid-run state: map, two concurrent seasonals, a loot window, drops, a warning. */
  function busy(): Rig {
    const r = inMap();
    r.drop(2);
    r.line(log.s12Entry, 'overrealm');
    r.line(log.s14Strum, 'lunaria');
    r.drop(1);
    r.line(log.s11Start, 'carjack');
    r.line(log.s11End, 'carjack end');
    return r;
  }

  it('begins with init_started and never contains excluded types, in any state', () => {
    const r = rig();
    const check = (label: string) => {
      const t = r.types();
      if (t.length === 0) return; // idle
      expect(t[0], label).toBe('init_started');
      for (const x of EXCLUDED) expect(t, `${label}: ${x}`).not.toContain(x);
    };
    r.start();        check('initializing');
    r.init();         check('tracking');
    r.go(TOWN, MAP);  check('map');
    r.drop(3);        check('drops');
    r.line(log.s11Start); r.line(log.s11End); check('loot window');
    r.pause();        check('paused');
    r.resume();       check('resumed');
    r.go(MAP, TOWN);  check('town');
    expect(r.replay().every(ev => !EXCLUDED.includes(ev.type))).toBe(true);
  });

  it('is deterministic: two calls are equal, and the call has no side effects', () => {
    const r = busy();
    const n = r.events.length;
    const a = r.replay();
    const b = r.replay();
    expect(a).toEqual(b);
    expect(r.events).toHaveLength(n); // nothing emitted
    r.eq('after getState calls');
    r.drop(1);                       // the run carries on normally
  });

  it('order: session, zone, map, seasonals in start order, then loot windows', () => {
    const r = busy();
    const evs = r.replay();
    const idx = (pred: (e: EngineEvent) => boolean) => evs.findIndex(pred);
    const started = (kind: string, st?: string) => (e: EngineEvent) =>
      e.type === 'tracker_started' && e.tracker.kind === kind && (st === undefined || e.tracker.seasonalType === st);

    const iInit = idx(e => e.type === 'init_complete');
    const iSess = idx(started('session'));
    const iZone = idx(e => e.type === 'zone_change');
    const iMap  = idx(started('map'));
    const iOver = idx(started('seasonal', 'overrealm'));
    const iLuna = idx(started('seasonal', 'lunaria'));
    const iCar  = idx(started('seasonal', 'carjack'));
    const iLoot = idx(e => e.type === 'loot_window_started');
    expect(evs[0].type).toBe('init_started');
    expect(iInit).toBeGreaterThan(0);
    for (const [a, b] of [[iInit, iSess], [iSess, iZone], [iZone, iMap], [iMap, iOver], [iOver, iLuna], [iLuna, iCar], [iCar, iLoot]]) {
      expect(a).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(a);
    }
    // owner is stamped on every replayed seasonal start
    for (const e of evs) {
      if (e.type === 'tracker_started' && e.tracker.kind === 'seasonal') expect(typeof e.tracker.owner).toBe('boolean');
    }
    expect(count(evs, 'loot_window_started')).toBe(r.deadlines().length);
  });

  it('session tracker_started carries sessionMeta and a snapshot taken NOW', () => {
    const r = inMap();
    r.drop(2);
    vi.advanceTimersByTime(7_000);
    const sess = r.replay().find((ev): ev is Extract<EngineEvent, {type: 'tracker_started'}> => ev.type === 'tracker_started' && ev.tracker.kind === 'session')!;
    expect(sess.sessionMeta).toMatchObject({sessionId: TEST_IDENTITY.sessionId, continued: false, mapCount: 1});
    expect(sess.tracker.elapsed).toBe(ctx(r.e).registry.session!.snapshot().elapsed);
    expect(sess.tracker.elapsed).toBeGreaterThanOrEqual(7_000);
    expect(sess.tracker.active).toBe(true);
    expect(sess.tracker.drops).toEqual({[LOOT]: 2});
  });

  it('paused: the session snapshot is inactive and no loot window is replayed', () => {
    const r = busy();
    r.pause();
    const sess = r.replay().find((ev): ev is Extract<EngineEvent, {type: 'tracker_started'}> => ev.type === 'tracker_started' && ev.tracker.kind === 'session')!;
    expect(sess.tracker.active).toBe(false);
    expect(count(r.replay(), 'loot_window_started')).toBe(0);
  });

  it('idle -> [], initializing -> [init_started], across stop/restart', () => {
    const r = rig();
    expect(r.replay()).toEqual([]);
    r.start();
    expect(r.types()).toEqual(['init_started']);
    r.init();
    r.e.stop();
    expect(r.replay()).toEqual([]);
    r.start();
    expect(r.types()).toEqual(['init_started']);
  });
});
