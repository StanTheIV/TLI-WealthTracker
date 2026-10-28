/**
 * 3.1 adversarial (MECHANICS table + configure path):
 *  (A) configure semantics: a reconfigure never alters a LIVE tracker's window,
 *      TrackingService.reconfigure keeps every other stored window, the low-stock
 *      threshold keeps its watch state and dismissals, and configured values
 *      survive start / stop -> start / Reset (and apply to the first run when set
 *      before start).
 *  (D) the table against GAMEPLAY: every fight/hub scene classifies through the
 *      real ZoneHandler, and a hide rule scoped to ONE mechanic hides only that
 *      mechanic's credit, for all 11 mechanics through the real engine.
 * Production chain only; complements engine-configure.test / mechanics.test.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEvent, SeasonalType} from '@/shared/contracts/engine';
import {FILTER_SCOPES, type FilterRule, type FilterScope} from '@/shared/item-filter';
import {MECHANICS, mechanic, type WindowedSeasonalType} from '@/shared/mechanics';
import {LOG_SUBPATH} from '@/shared/paths';
import {parseSettings} from '@/shared/settings';
import {
  MAP, SANDLORD_HUB, SANDLORD_SUB_MAP, TEST_IDENTITY, TOWN,
  boot, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {LOOT, rig, type Rig} from './interlude-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const ITEM = 100;

/** The log lines that start each windowed mechanic and arm its window. */
const ARM: Record<WindowedSeasonalType, string[]> = {
  overrealm:  [log.s12Entry, log.s12Exit],
  carjack:    [log.s11Start],
  clockwork:  [log.s7Podium, log.s7Turnin],
  lunaria:    [log.s14Strum],
  sandlord:   [log.s10Wave],
  hunting:    [log.huntingStatue, log.huntingBossStart, log.huntingBossEnd],
  afterlight: [log.afterlightStart],
};
const WINDOWED = MECHANICS.flatMap(m => (m.window ? [m.key] : []));

type WindowStarted = Extract<EngineEvent, {type: 'loot_window_started'}>;

/** Lengths (ms) of every window armed for `type`, from event index `from`. */
function windows(events: EngineEvent[], type: SeasonalType, from = 0): number[] {
  return events.slice(from)
    .filter((ev): ev is WindowStarted => ev.type === 'loot_window_started' && ev.seasonalType === type)
    .map(ev => ev.deadline - ev.timestamp);
}

function fresh() {
  const events: EngineEvent[] = [];
  const e = createEngine(events);
  let d = createDispatcher();
  return {
    events, e,
    /** start + bag init (a new dispatcher per session, like a new worker run). */
    begin: () => { d = createDispatcher(); boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 10}]); },
    line:  (l: string) => feed(d, e, l),
    go:    (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
  };
}
type Fresh = ReturnType<typeof fresh>;

/** town -> map, run the mechanic's arming lines, return the windows it armed. */
function runMechanic(f: Fresh, type: WindowedSeasonalType): number[] {
  const at = f.events.length;
  f.go(TOWN, MAP);
  for (const l of ARM[type]) f.line(l);
  return windows(f.events, type, at);
}

// ---------------------------------------------------------------------------
// (A) configure semantics
// ---------------------------------------------------------------------------

describe('(A) a reconfigure never alters a LIVE tracker', () => {
  it.each(WINDOWED)('%s: windows armed by the live run stay at the old value; the next run uses the new one', (type) => {
    const f = fresh();
    f.begin();
    const key = mechanic(type).window.settingKey;
    const def = mechanic(type).window.defaultMs;

    expect(runMechanic(f, type)).not.toEqual([]);
    const at = f.events.length;
    f.e.configure(parseSettings({[key]: '9000'}));
    // The live run re-arms its window. Clockwork is the exception: its arming
    // lines start the 10 s cogwheel idle window; see the turn-in test below.
    if (type !== 'clockwork') for (const l of ARM[type]) f.line(l);
    expect(windows(f.events, type, at).every(w => w === def), 'live run keeps its window').toBe(true);

    f.go(MAP, TOWN);                                      // town entry finishes it
    expect(ctx(f.e).registry.seasonalsSize()).toBe(0);
    expect(runMechanic(f, type).pop()).toBe(9000);
  });

  // Characterisation (kept from the pre-table setter): Clockwork re-applies the
  // handler's current window at each turn-in, so a value configured between the
  // podium and the turn-in is what that turn-in arms. The window already armed
  // (the cogwheel idle one) is untouched.
  it('clockwork: a turn-in AFTER the reconfigure arms the new window; the idle window already armed is unchanged', () => {
    const f = fresh();
    f.begin();
    f.go(TOWN, MAP);
    f.line(log.s7Podium);
    const at = f.events.length;
    f.e.configure(parseSettings({clockworkLootMs: '9000'}));
    expect(windows(f.events, 'clockwork', at)).toEqual([]);
    f.line(log.s7Turnin);
    expect(windows(f.events, 'clockwork', at).pop()).toBe(9000);
  });

  it('a reconfigure of ONE key leaves every other mechanic at its own value', () => {
    const f = fresh();
    f.e.configure(parseSettings({carjackLootMs: '7000', lunariaLootMs: '3000'}));
    f.begin();
    f.e.configure(parseSettings({carjackLootMs: '7000', lunariaLootMs: '3000', overrealmLootMs: '9000'}));
    expect(runMechanic(f, 'carjack').pop()).toBe(7000);
    f.go(MAP, TOWN);
    expect(runMechanic(f, 'lunaria').pop()).toBe(3000);
    f.go(MAP, TOWN);
    expect(runMechanic(f, 'overrealm').pop()).toBe(9000);
    f.go(MAP, TOWN);
    expect(runMechanic(f, 'hunting').pop()).toBe(5000);
  });
});

describe('(A) configured values survive the engine lifecycle', () => {
  const VALUE = 4321;

  it.each(WINDOWED)('%s: set BEFORE start applies to the first run, and survives Reset and stop -> start', (type) => {
    const f = fresh();
    f.e.configure(parseSettings({[mechanic(type).window.settingKey]: String(VALUE)}));   // before any start

    f.begin();
    expect(runMechanic(f, type).pop(), 'first run').toBe(VALUE);
    f.go(MAP, TOWN);

    f.e.reset(TEST_IDENTITY);
    expect(runMechanic(f, type).pop(), 'after Reset').toBe(VALUE);
    f.go(MAP, TOWN);

    f.e.stop();
    f.begin();
    expect(runMechanic(f, type).pop(), 'after stop -> start').toBe(VALUE);
    f.go(MAP, TOWN);

    f.e.start(TEST_IDENTITY);                                              // a bare restart, no stop
    f.begin();
    expect(runMechanic(f, type).pop(), 'after a second start').toBe(VALUE);
  });

  it('lowStockThreshold set before start / across stop -> start still warns at the configured level', () => {
    const f = fresh();
    f.e.configure(parseSettings({lowStockThreshold: '8'}));
    const warnedItems = (): Array<{itemId: number; quantity: number}> => {
      const w = f.events.filter((ev): ev is Extract<EngineEvent, {type: 'map_material_warning'}> => ev.type === 'map_material_warning');
      return w[w.length - 1]?.items ?? [];
    };
    const twoSpentMaps = () => {
      let qty = 10;
      const spend = () => { qty -= 1; f.line(log.bagUpdate(1, ITEM, qty)); };
      spend(); f.go(TOWN, MAP); f.go(MAP, TOWN);
      spend(); f.go(TOWN, MAP);
    };
    f.begin(); twoSpentMaps();
    expect(warnedItems()).toEqual([{itemId: ITEM, quantity: 8}]);

    f.e.stop();
    f.events.length = 0;
    f.begin(); twoSpentMaps();
    expect(warnedItems()).toEqual([{itemId: ITEM, quantity: 8}]);
  });
});

describe('(A) MapMaterial: a threshold change mid-map keeps the watch state and the dismissals', () => {
  const A = 100, B = 101;

  function scenario(dismissA: boolean) {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    const d = createDispatcher();
    boot(d, e, [{slotId: 1, itemId: A, quantity: 10}, {slotId: 2, itemId: B, quantity: 10}]);
    const line = (l: string) => feed(d, e, l);
    const go   = (from: string, to: string) => line(log.zoneTransition(from, to));
    // two consecutive paid maps: both watched (streak 2), left at 8 / 8; threshold 0 => silent
    line(log.bagUpdate(1, A, 9)); line(log.bagUpdate(2, B, 9)); go(TOWN, MAP); go(MAP, TOWN);
    line(log.bagUpdate(1, A, 8)); line(log.bagUpdate(2, B, 8)); go(TOWN, MAP);
    const warnings = () => events.filter((ev): ev is Extract<EngineEvent, {type: 'map_material_warning'}> => ev.type === 'map_material_warning');
    expect(warnings().pop()?.items).toEqual([]);

    if (dismissA) e.dismissMaterial(A);
    e.configure(parseSettings({lowStockThreshold: '9'}));                  // mid-map
    // B is picked up in the map (8 -> 9 >= 2): a refresh runs with the NEW threshold
    line(log.bagUpdate(2, B, 9));
    return warnings().pop()?.items;
  }

  it('the watch survives: both watched items warn under the new threshold', () => {
    expect(scenario(false)).toEqual([{itemId: A, quantity: 8}, {itemId: B, quantity: 9}]);
  });

  it('a dismissal survives the change: the dismissed item stays out of the warning', () => {
    expect(scenario(true)).toEqual([{itemId: B, quantity: 9}]);
  });
});

// ---- TrackingService.reconfigure (real engine, trimmed harness) -----------------

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';

function service(settings: Record<string, string>) {
  const sent: EngineEvent[] = [];
  const engines: ReturnType<typeof createProductionEngine>[] = [];
  let onEvent!: (raw: RawEvent) => void;
  const noop = vi.fn();
  const worker = {start: vi.fn(), stop: vi.fn()};
  const s = new TrackingService({
    createEngine:   emit => { const e = createProductionEngine(emit); engines.push(e); return e; },
    store:          new SqliteSessionStore(openMigratedNodeSqlite()),
    broadcast:      (channel, payload) => { if (channel === 'engine:event') sent.push(payload as EngineEvent); },
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => settings},
    filters:        {getAll: () => []},
    items:          {
      getAll: () => [], getLocked: () => false, insertIfMissing: () => true,
      recordScrapedPrice: () => ({priceDate: Date.now()}),
    } as unknown as TrackingDeps['items'],
    wealthRecorder: {snapshot: noop},
    log:            {debug: noop, info: noop, warn: noop, error: noop},
  });
  const d = createDispatcher();
  const feedLine = (l: string) => { for (const ev of d.dispatch(l)) onEvent(ev); };
  return {s, sent, feedLine, settings, logPath: `${TORCHLIGHT}/${LOG_SUBPATH}`};
}

describe('(A) TrackingService.reconfigure keeps every OTHER window at its stored value', () => {
  const STORED = {torchlightPath: TORCHLIGHT, carjackLootMs: '7000', lunariaLootMs: '3000', overrealmLootMs: '9000'};

  /** The window each mechanic arms in its own fresh map, in the service's live engine. */
  function measure(h: ReturnType<typeof service>, types: WindowedSeasonalType[]): Record<string, number | undefined> {
    const out: Record<string, number | undefined> = {};
    for (const type of types) {
      const at = h.sent.length;
      h.feedLine(log.zoneTransition(TOWN, MAP));
      for (const l of ARM[type]) h.feedLine(l);
      out[type] = windows(h.sent, type, at).pop();
      h.feedLine(log.zoneTransition(MAP, TOWN));
    }
    return out;
  }
  const initBag = (h: ReturnType<typeof service>) => {
    h.feedLine(log.bagInit(1, ITEM, 10));
    h.feedLine(log.bagInit(2, 900, 1));
    vi.advanceTimersByTime(600);
  };

  const CASES: Array<[string, Record<string, string> | undefined, Record<string, number>]> = [
    ['no overrides',                  undefined,                          {carjack: 7000, lunaria: 3000, overrealm: 9000, hunting: 5000}],
    ['empty overrides',               {},                                 {carjack: 7000, lunaria: 3000, overrealm: 9000, hunting: 5000}],
    ['an unrelated key',              {somethingElse: 'x'},               {carjack: 7000, lunaria: 3000, overrealm: 9000, hunting: 5000}],
    ['one valid override',            {huntingLootMs: '2500'},            {carjack: 7000, lunaria: 3000, overrealm: 9000, hunting: 2500}],
    ['a garbage override of one key', {overrealmLootMs: 'abc'},           {carjack: 7000, lunaria: 3000, overrealm: 5000, hunting: 5000}],
    ['an empty-string override',      {carjackLootMs: ''},                {carjack: 5000, lunaria: 3000, overrealm: 9000, hunting: 5000}],
    ['a negative override',           {lunariaLootMs: '-1'},              {carjack: 7000, lunaria: 5000, overrealm: 9000, hunting: 5000}],
    ['garbage everywhere new',        {huntingLootMs: 'NaN', x: '', afterlightLootMs: '0'}, {carjack: 7000, lunaria: 3000, overrealm: 9000, hunting: 5000}],
  ];

  it.each(CASES)('%s', (_n, overrides, expected) => {
    const h = service({...STORED});
    h.s.start();
    initBag(h);
    expect(measure(h, ['carjack', 'lunaria', 'overrealm', 'hunting'])).toEqual(expect.objectContaining(
      {carjack: 7000, lunaria: 3000, overrealm: 9000, hunting: 5000}));   // the stored table is live

    h.s.reconfigure(overrides);
    expect(measure(h, ['carjack', 'lunaria', 'overrealm', 'hunting'])).toEqual(expected);
    expect(h.settings).toEqual(STORED);                                    // reconfigure never writes the table
  });

  it('a window applied by one reconfigure is NOT sticky: the next one rebuilds from the table', () => {
    const h = service({...STORED});
    h.s.start();
    initBag(h);
    h.s.reconfigure({huntingLootMs: '2500'});
    expect(measure(h, ['hunting']).hunting).toBe(2500);
    h.s.reconfigure();                                                     // the table has no hunting key
    expect(measure(h, ['hunting']).hunting).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// (D) the table against GAMEPLAY
// ---------------------------------------------------------------------------

describe('(D) scene classification through the real ZoneHandler', () => {
  const sceneOf = (name: string) => `/Game/Art/Season/SXX/Maps/${name}/${name}000.${name}000`;

  /** The location after entering `scene` from town, on a started + initialised engine. */
  function locationAfter(scene: string, from = TOWN) {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);                                // a map first, so a map -> X detour is covered too
    if (from === TOWN) o.go(MAP, TOWN);
    o.go(from, scene);
    return {loc: ctx(o.e).location, o};
  }

  const FIGHTS = MECHANICS.flatMap(m => ('fightScene' in m ? [[m.key, m.fightScene] as const] : []));
  const HUBS   = MECHANICS.flatMap(m => ('hubScene' in m ? [[m.key, m.hubScene] as const] : []));

  it('the table has exactly the GAMEPLAY interlude fight scenes and the one hub', () => {
    expect(FIGHTS.map(([k]) => k).sort()).toEqual(['arcana', 'tartarus', 'vorex']);
    expect(HUBS.map(([k]) => k)).toEqual(['sandlord']);
  });

  it.each(FIGHTS)('%s: its fight scene is a seasonal-scene, from town AND from a map, never a map', (_k, scene) => {
    expect(locationAfter(sceneOf(scene), TOWN).loc).toBe('seasonal-scene');
    expect(locationAfter(sceneOf(scene), MAP).loc).toBe('seasonal-scene');
    const {o} = locationAfter(sceneOf(scene), MAP);
    expect(o.events.filter(e => e.type === 'zone_change').pop()).toMatchObject({entering: 'unknown'});
  });

  it.each(HUBS)('%s: its hub scene is the hub (a coarser "map" for the renderer), not a seasonal-scene', (_k, scene) => {
    const {loc, o} = locationAfter(sceneOf(scene), MAP);
    expect(loc).toBe('hub');
    expect(o.events.filter(e => e.type === 'zone_change').pop()).toMatchObject({entering: 'map'});
  });

  it('a map scene matches no marker, and stays a map even when its path is dressed like a season scene', () => {
    const markers = MECHANICS.flatMap(m => [...('fightScene' in m ? [m.fightScene] : []), ...('hubScene' in m ? [m.hubScene] : [])]);
    for (const scene of [MAP, SANDLORD_SUB_MAP, '/Game/Art/Season/S5/Maps/MengJing/MengJing.MengJing', '/Game/Art/Maps/06SQ/XX_Plain100/XX_Plain100']) {
      expect(markers.filter(m => scene.includes(m)), scene).toEqual([]);
    }
    expect(locationAfter(MAP, TOWN).loc).toBe('map');
    expect(locationAfter('/Game/Art/Season/S5/Maps/MengJing/MengJing.MengJing', TOWN).loc).toBe('map');
  });

  it('a hub sub-map is the hub only while the player came from the hub', () => {
    const o = rig();
    o.init(); o.go(TOWN, MAP); o.go(MAP, SANDLORD_HUB);
    o.go(SANDLORD_HUB, SANDLORD_SUB_MAP);
    expect(ctx(o.e).location).toBe('hub');
    o.go(SANDLORD_SUB_MAP, TOWN);
    o.go(TOWN, SANDLORD_SUB_MAP);
    expect(ctx(o.e).location).toBe('map');
  });
});

describe('(D) a hide rule scoped to ONE mechanic hides only that mechanic', () => {
  /** Put `type` in progress inside a running map and make it the drop writer. */
  const OPEN: Record<SeasonalType, (o: Rig) => void> = {
    vorex:      o => { o.line(log.s13Start); },
    dream:      o => { o.line(log.levelType(11)); },
    overrealm:  o => { o.line(log.s12Entry); },
    carjack:    o => { o.line(log.s11Start); },
    clockwork:  o => { o.line(log.s7Podium); o.line(log.s7Cogwheel); o.line(log.s7Turnin); },
    sandlord:   o => { o.go(MAP, SANDLORD_HUB); },
    lunaria:    o => { o.line(log.s14Strum); },
    arcana:     o => { o.line(log.s9Minigame); },
    hunting:    o => { o.line(log.huntingStatue); o.line(log.huntingBossStart); },
    afterlight: o => { o.line(log.afterlightStart); },
    tartarus:   o => { o.line(log.s16BoardOpen); },
  };

  const rule = (scopes: FilterScope[]): FilterRule => ({id: 'r', action: 'hide', kind: {type: 'by-item', itemId: String(LOOT)}, scopes});

  /** Run `type`, apply `scopes` as the only rule, pick up one LOOT. */
  function credits(type: SeasonalType, scopes: FilterScope[]) {
    const o = rig();
    o.init(); o.go(TOWN, MAP); o.adv(1_000);
    OPEN[type](o);
    o.e.setFilterRules([rule(scopes)]);
    const run = o.seasonal(type);
    expect(run?.active, `${type} live`).toBe(true);
    expect(ctx(o.e).registry.writer(), `${type} owns the drop`).toBe(type);
    const mapLive = o.map()?.active === true;
    o.drop(1);
    const n = (d: Record<string, number> | undefined) => d?.[LOOT] ?? 0;
    return {
      mapLive,
      session: n(ctx(o.e).registry.session?.snapshot().drops),
      map:     n(o.map()?.snapshot().drops),
      own:     n(o.seasonal(type)?.snapshot().drops),
      source:  n(ctx(o.e).registry.session?.snapshot().dropsBySource?.[type]),
      o,
    };
  }

  const ALL = MECHANICS.map(m => m.key);

  it('covers all 11 mechanics', () => {
    expect(Object.keys(OPEN).sort()).toEqual([...ALL].sort());
    expect(ALL).toHaveLength(11);
  });

  it.each(ALL)('%s: hide scoped to its own scope removes only its own credit', (type) => {
    const r = credits(type, [type]);
    expect(r.own,     'the mechanic\'s own tracker is hidden').toBe(0);
    expect(r.session, 'session is a different scope').toBe(1);
    expect(r.map,     'map is a different scope (and frozen for map-freezing runs)').toBe(r.mapLive ? 1 : 0);
    expect(r.source,  'the by-source split follows the SESSION scope').toBe(1);
    r.o.assertClean();
  });

  it.each(ALL)('%s: hide scoped to every OTHER mechanic hides nothing', (type) => {
    const others = FILTER_SCOPES.filter(s => s !== type && s !== 'session' && s !== 'map');
    const r = credits(type, others);
    expect(r.own).toBe(1);
    expect(r.session).toBe(1);
    expect(r.map).toBe(r.mapLive ? 1 : 0);
    expect(r.source).toBe(1);
  });

  it.each(ALL)('%s: hide scoped to [session] / [map] each hides only that tier', (type) => {
    const s = credits(type, ['session']);
    expect([s.session, s.own, s.map, s.source]).toEqual([0, 1, s.mapLive ? 1 : 0, 0]);
    const m = credits(type, ['map']);
    expect([m.session, m.own, m.map, m.source]).toEqual([1, 1, 0, 1]);
  });
});
