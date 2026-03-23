/**
 * Seasonal mechanic integration tests: raw log line → Dispatcher → Engine → handlers.
 *
 * These tests exercise the full pipeline from realistic game log strings all the
 * way through to tracker state and emitted EngineEvents — the same path that
 * runs in production. No mocking of internal engine state.
 *
 * Stack under test:
 *   log line
 *     → Dispatcher (S13Processor / S12Processor / LevelTypeProcessor / ...)
 *     → Engine.onRawEvent()
 *     → DreamHandler / VorexHandler / OverrealmHandler
 *     → ctx.seasonal (Tracker) + emitted EngineEvents
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Dispatcher}       from '@/worker/dispatcher';
import {BagProcessor}     from '@/worker/processors/bag';
import {ZoneProcessor}    from '@/worker/processors/zone';
import {LevelTypeProcessor} from '@/worker/processors/level-type';
import {S13Processor}     from '@/worker/processors/s13';
import {S12Processor}     from '@/worker/processors/s12';
import {CurrencyProcessor} from '@/worker/processors/currency';
import {Engine}           from '@/main/engine/engine';
import {BagInitHandler}   from '@/main/engine/handlers/bag-init';
import {ZoneHandler}      from '@/main/engine/handlers/zone';
import {DreamHandler}     from '@/main/engine/handlers/dream-handler';
import {VorexHandler}     from '@/main/engine/handlers/vorex-handler';
import {OverrealmHandler} from '@/main/engine/handlers/overrealm-handler';
import {ItemHandler}      from '@/main/engine/handlers/item';
import type {EngineEvent} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

// ---------------------------------------------------------------------------
// Realistic log line fixtures — copied from actual game log format
// ---------------------------------------------------------------------------

const ts = '[2026.01.25-12.34.56:789]';

const log = {
  bagInit:  (slotId: number, itemId: number, qty: number) =>
    `${ts}GameLog: Display: [Game] BagMgr@:InitBagData PageId = 0 SlotId = ${slotId} ConfigBaseId = ${itemId} Num = ${qty}`,

  bagUpdate: (slotId: number, itemId: number, qty: number) =>
    `${ts}GameLog: Display: [Game] BagMgr@:Modfy BagItem PageId = 0 SlotId = ${slotId} ConfigBaseId = ${itemId} Num = ${qty}`,

  zoneTransition: (from: string, to: string) =>
    `PageApplyBase@ _UpdateGameEnd: LastSceneName = World'${from}' NextSceneName = World'${to}'`,

  levelType: (n: number) =>
    `${ts} PreloadLevelType = ${n}`,

  s13Start:       `${ts} S13GamePlayMain Run`,
  s13WindowClose: `${ts} S13GamePlayMain::Destory`,
  s13Abandon:     `${ts} S13GamePlay Destory`,

  s12Entry:       `${ts} USceneEffectMgr::S12SwitchFinish called`,
  portalExit:     `${ts} Create Map Portal cfgId 52`,
  portalOther:    `${ts} Create Map Portal cfgId 50`,

  currency: (id: number, amount: number) =>
    `${ts} ResourceMgr@:ChangeCurrency(${id}, ${amount})`,
};

const TOWN = 'XZ_YuJinZhiXiBiNanSuo200';
const MAP  = '/Game/Art/Maps/S5_Boss';
const VOREX_REWARD = '/Game/Art/Season/S13/DiXiaZhenSuo_Reward';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDispatcher(): Dispatcher {
  const d = new Dispatcher();
  d.register(new BagProcessor());
  d.register(new ZoneProcessor());
  d.register(new LevelTypeProcessor());
  d.register(new S13Processor());
  d.register(new S12Processor());
  d.register(new CurrencyProcessor());
  return d;
}

function createEngine(events: EngineEvent[]): Engine {
  return new Engine((e) => events.push(e))
    .register(new BagInitHandler())
    .register(new ZoneHandler())
    .register(new DreamHandler())
    .register(new VorexHandler())
    .register(new OverrealmHandler())
    .register(new ItemHandler());
}

/** Feed a log line through the full dispatcher → engine pipeline. */
function feed(dispatcher: Dispatcher, engine: Engine, line: string): void {
  for (const event of dispatcher.dispatch(line)) {
    engine.onRawEvent(event);
  }
}

/** Reach into the engine's private context (test-only). */
function ctx(engine: Engine): EngineContext {
  return (engine as unknown as {_ctx: EngineContext})._ctx;
}

/** Boot engine and complete bag init with a given inventory. */
function boot(
  dispatcher: Dispatcher,
  engine: Engine,
  inventory: Array<{slotId: number; itemId: number; quantity: number}>,
): void {
  engine.start();
  for (const {slotId, itemId, quantity} of inventory) {
    feed(dispatcher, engine, log.bagInit(slotId, itemId, quantity));
  }
  vi.advanceTimersByTime(600); // BagInitHandler debounce
}

beforeEach(() => {
  vi.useFakeTimers();
});

// ---------------------------------------------------------------------------
// Dream (S5) — level_type transitions
// ---------------------------------------------------------------------------

describe('Dream integration', () => {
  it('level_type 3→11 starts dream tracker, 11→3 finishes it', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Enter Dream
    feed(d, e, log.levelType(11));
    expect(ctx(e).seasonal?.seasonalType).toBe('dream');
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'dream')).toBe(true);

    // Drop inside Dream reaches seasonal tracker
    feed(d, e, log.bagUpdate(1, 100, 5));
    expect(ctx(e).seasonal?.snapshot().drops[100]).toBe(5);

    // Exit Dream
    feed(d, e, log.levelType(3));
    expect(ctx(e).seasonal).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'dream')).toBe(true);
  });

  it('drops inside Dream reach session, map and dream trackers simultaneously', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.levelType(11));

    feed(d, e, log.bagUpdate(1, 100, 3));

    expect(ctx(e).session?.snapshot().drops[100]).toBe(3);
    expect(ctx(e).map?.snapshot().drops[100]).toBe(3);
    expect(ctx(e).seasonal?.snapshot().drops[100]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Vorex (S13) — window open/close/abandon
// ---------------------------------------------------------------------------

describe('Vorex integration', () => {
  it('s13_start starts vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    expect(ctx(e).seasonal?.seasonalType).toBe('vorex');
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('s13_window_close pauses the vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    feed(d, e, log.s13WindowClose);

    expect(ctx(e).seasonal?.seasonalType).toBe('vorex');
    expect(ctx(e).seasonal?.active).toBe(false); // paused
    expect(events.some(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('second s13_start after window_close resumes the vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13WindowClose);

    expect(ctx(e).seasonal?.active).toBe(false);

    feed(d, e, log.s13Start); // reopen
    expect(ctx(e).seasonal?.active).toBe(true);
  });

  it('s13_abandon → zone to reward zone completes Vorex, tracker stays alive', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13Abandon);

    expect(ctx(e).vorexAbandoning).toBe(true);

    // Zone to reward zone = completed
    feed(d, e, log.zoneTransition(MAP, VOREX_REWARD));

    expect(ctx(e).vorexAbandoning).toBe(false);
    expect(ctx(e).seasonal?.seasonalType).toBe('vorex'); // still alive for loot
    expect(ctx(e).seasonal?.active).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false); // not finished yet
  });

  it('s13_abandon → zone to non-reward zone abandons Vorex, tracker finishes', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13Abandon);

    // Zone to some other area = abandoned
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).vorexAbandoning).toBe(false);
    expect(ctx(e).seasonal).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('drops inside Vorex reach session, map and vorex trackers', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    feed(d, e, log.bagUpdate(1, 200, 4));

    expect(ctx(e).session?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).map?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).seasonal?.snapshot().drops[200]).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Overrealm (S12) — entry / exit / loot collection timer
// ---------------------------------------------------------------------------

describe('Overrealm integration', () => {
  it('s12_entry starts overrealm tracker on first stage', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);

    expect(ctx(e).seasonal?.seasonalType).toBe('overrealm');
    expect(ctx(e).inOverrealm).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'overrealm')).toBe(true);
  });

  it('subsequent s12_entry events (stage 2/3) do not restart the tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry); // stage 1
    feed(d, e, log.s12Entry); // stage 2 — should be ignored

    const started = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'overrealm');
    expect(started).toHaveLength(1);
  });

  it('portal 52 sets overrealmExiting flag', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);

    feed(d, e, log.portalExit);
    expect(ctx(e).overrealmExiting).toBe(true);
  });

  it('other portal IDs do not set overrealmExiting', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);

    feed(d, e, log.portalOther); // cfgId 50 — internal portal, ignored
    expect(ctx(e).overrealmExiting).toBe(false);
  });

  it('zone transition after portal 52 starts loot collection timer, tracker stays alive', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.portalExit);

    // Zone transition back to map = exited Overrealm
    feed(d, e, log.zoneTransition(MAP, MAP + '_next'));

    expect(ctx(e).inOverrealm).toBe(false);
    expect(ctx(e).overrealmExiting).toBe(false);
    expect(ctx(e).seasonal?.seasonalType).toBe('overrealm'); // timer still running
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('drops during loot window are attributed to overrealm tracker', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.portalExit);
    feed(d, e, log.zoneTransition(MAP, MAP + '_next'));

    // Still in loot window — bag update should reach overrealm tracker
    feed(d, e, log.bagUpdate(1, 300, 7));
    expect(ctx(e).seasonal?.snapshot().drops[300]).toBe(7);
  });

  it('loot timer expires and finishes overrealm tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.portalExit);
    feed(d, e, log.zoneTransition(MAP, MAP + '_next'));

    expect(ctx(e).seasonal?.seasonalType).toBe('overrealm');

    // Advance past the 5-second loot window
    vi.advanceTimersByTime(5_100);

    expect(ctx(e).seasonal).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'overrealm')).toBe(true);
  });

  it('bag_update during loot window refreshes timer when below 80% threshold', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.portalExit);
    feed(d, e, log.zoneTransition(MAP, MAP + '_next'));

    // Advance to 4.5s (remaining=0.5s < 80% threshold=4s → refresh resets to 4s)
    vi.advanceTimersByTime(4_500);
    expect(ctx(e).seasonal?.seasonalType).toBe('overrealm'); // still alive

    feed(d, e, log.bagUpdate(1, 300, 2)); // triggers refresh → timer reset to 4s

    // 3.9s later — still within the refreshed 4s window
    vi.advanceTimersByTime(3_900);
    expect(ctx(e).seasonal?.seasonalType).toBe('overrealm'); // still alive

    // Let it expire (0.1s + buffer)
    vi.advanceTimersByTime(200);
    expect(ctx(e).seasonal).toBeNull();
  });

  it('entering town during loot window cancels timer and finishes tracker immediately', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.portalExit);
    feed(d, e, log.zoneTransition(MAP, MAP + '_next'));

    expect(ctx(e).seasonal?.seasonalType).toBe('overrealm');

    // Enter town — should cancel timer and finish immediately
    feed(d, e, log.zoneTransition(MAP + '_next', TOWN));

    expect(ctx(e).seasonal).toBeNull();
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'overrealm')).toBe(true);

    // Timer should be gone — no double-finish after original timeout
    events.length = 0;
    vi.advanceTimersByTime(5_100);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false);
  });

  it('re-entering Overrealm during loot window cancels timer and resumes session', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 300, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry);
    feed(d, e, log.portalExit);
    feed(d, e, log.zoneTransition(MAP, MAP + '_next'));

    // Re-enter before timer expires
    feed(d, e, log.s12Entry);

    expect(ctx(e).inOverrealm).toBe(true);
    expect(ctx(e).seasonal?.seasonalType).toBe('overrealm');

    // Timer cancelled — advancing time should not finish the tracker
    vi.advanceTimersByTime(6_000);
    expect(ctx(e).seasonal?.seasonalType).toBe('overrealm');
  });
});

// ---------------------------------------------------------------------------
// Currency processor
// ---------------------------------------------------------------------------

describe('Currency processor integration', () => {
  it('currency_change log line produces currency_change RawEvent via dispatcher', () => {
    const d = createDispatcher();
    const events = d.dispatch(log.currency(4, 250));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'currency_change', currencyId: 4, amount: 250});
  });

  it('handles negative amounts (spending currency)', () => {
    const d = createDispatcher();
    const events = d.dispatch(log.currency(4, -50));
    expect(events[0]).toEqual({type: 'currency_change', currencyId: 4, amount: -50});
  });
});
