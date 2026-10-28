/**
 * Adversarial cases for "pause is a tracking-only command": outside 'tracking'
 * it is dropped and leaves no trace; paused implies tracking; inside tracking
 * pause/resume behave as before.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import {checkUnits} from '@/test/unit-invariant';
import {
  TEST_IDENTITY,
  boot, createDispatcher, createEngine, createEngineWithEmit, ctx, feed, log,
  MAP, TOWN, ARCANA_FIGHT,
} from './seasonal-fixtures';

const T0 = new Date('2026-03-01T12:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

const statuses = (events: EngineEvent[]) =>
  events.filter(e => e.type === 'session_status');
const statusNames = (events: EngineEvent[]) =>
  statuses(events).map(s => (s as {status: string}).status);

/** Same script, with or without pause/resume spam while initializing. */
function run(spam: boolean): EngineEvent[] {
  vi.setSystemTime(T0);
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  e.start(TEST_IDENTITY);
  if (spam) { e.pause(); e.pause(); e.resume(); e.pause(); e.resume(); e.resume(); }
  feed(d, e, log.bagInit(1, 100, 0));
  if (spam) { e.pause(); e.resume(); }
  vi.advanceTimersByTime(600);
  feed(d, e, log.zoneTransition(TOWN, MAP));
  feed(d, e, log.bagUpdate(1, 100, 4));
  vi.advanceTimersByTime(30_000);
  feed(d, e, log.zoneTransition(MAP, TOWN));
  e.stop();
  return events;
}

describe('pause spam while initializing', () => {
  it('yields an event stream identical to a run with no pause calls', () => {
    const clean = run(false);
    const spammed = run(true);
    expect(spammed).toEqual(clean);
    expect(statuses(spammed)).toEqual([]);
    expect(checkUnits(spammed)).toEqual([]);
  });
});

describe('continue-session (loadSession) paused during init', () => {
  it('keeps loaded drops/time, runs unpaused and adds time normally', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    e.loadSession({drops: {'300': 4}, dropsBySource: {}, spent: {}, totalTime: 120, mapTime: 100, mapCount: 2});
    e.start({sessionId: 's1', name: 'old'});
    e.pause();
    e.pause();
    expect(ctx(e).paused).toBe(false);
    expect(ctx(e).loadedSession).not.toBeNull();

    feed(d, e, log.bagInit(1, 100, 0));
    vi.advanceTimersByTime(600);

    const session = ctx(e).registry.session!;
    expect(ctx(e).paused).toBe(false);
    expect(session.active).toBe(true);
    expect(session.snapshot().drops[300]).toBe(4);
    expect(ctx(e).mapCount).toBe(2);
    expect(ctx(e).accumulatedMapTime).toBe(100_000);
    const at = session.elapsed();
    expect(at).toBeGreaterThanOrEqual(120_000);
    vi.advanceTimersByTime(7_000);
    expect(session.elapsed()).toBe(at + 7_000);
    expect(statuses(events)).toEqual([]);
  });
});

describe('no stale pause flag across runs', () => {
  it('pause in tracking, stop, restart: pause during the new init is dropped and the new session runs', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    e.pause();
    expect(ctx(e).paused).toBe(true);
    e.stop();
    expect(ctx(e).paused).toBe(false);
    expect(ctx(e).phase).toBe('idle');

    const before = events.length;
    e.start(TEST_IDENTITY);
    e.pause();
    expect(ctx(e).paused).toBe(false);
    expect(statuses(events.slice(before))).toEqual([]);

    feed(d, e, log.bagInit(1, 100, 0));
    vi.advanceTimersByTime(600);
    expect(ctx(e).phase).toBe('tracking');
    expect(ctx(e).paused).toBe(false);
    const at = ctx(e).registry.session!.elapsed();
    vi.advanceTimersByTime(5_000);
    expect(ctx(e).registry.session!.elapsed()).toBe(at + 5_000);
  });

  it('restart without stop (start while paused in tracking) clears the flag', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    const d = createDispatcher();
    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    e.pause();
    e.start(TEST_IDENTITY);
    expect(ctx(e).phase).toBe('initializing');
    expect(ctx(e).paused).toBe(false);
  });
});

describe('reset while paused', () => {
  it('stays paused and tracking, frozen until resume', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    e.pause();
    e.reset(TEST_IDENTITY);
    expect(ctx(e).phase).toBe('tracking');
    expect(ctx(e).paused).toBe(true);
    expect(ctx(e).registry.session!.active).toBe(false);
    vi.advanceTimersByTime(10_000);
    const el = ctx(e).registry.session!.elapsed();
    vi.advanceTimersByTime(10_000);
    expect(ctx(e).registry.session!.elapsed()).toBe(el);

    e.resume();
    expect(ctx(e).paused).toBe(false);
    expect(ctx(e).registry.session!.active).toBe(true);
  });

  it('reset during initializing is dropped; pause afterwards is still dropped', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    e.start(TEST_IDENTITY);
    e.reset(TEST_IDENTITY);
    e.pause();
    expect(ctx(e).paused).toBe(false);
    expect(ctx(e).phase).toBe('initializing');
  });
});

describe('pause inside tracking is unchanged', () => {
  it('between init and first map: one paused status, double pause emits once, resume emits running once', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    e.pause();
    e.pause();
    expect(statusNames(events)).toEqual(['paused']);
    e.resume();
    e.resume();
    expect(statusNames(events)).toEqual(['paused', 'running']);
  });

  it('in a seasonal scene (Arcana fight) pause freezes the session once', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT));
    e.pause();
    e.pause();
    expect(statuses(events)).toHaveLength(1);
    expect(ctx(e).registry.session!.active).toBe(false);
    const el = ctx(e).registry.session!.elapsed();
    vi.advanceTimersByTime(20_000);
    expect(ctx(e).registry.session!.elapsed()).toBe(el);
    e.resume();
    expect(ctx(e).registry.session!.active).toBe(true);
  });
});

describe('invariant sweep: paused implies tracking', () => {
  it('holds at every emit and after every step of a mixed script', () => {
    const d = createDispatcher();
    const violations: string[] = [];
    let e: ReturnType<typeof createEngine>;
    e = createEngineWithEmit(ev => {
      const c = ctx(e);
      if (c.paused && c.phase !== 'tracking') violations.push(`emit ${ev.type}: paused in ${c.phase}`);
    });
    const step = (label: string, fn: () => void) => {
      fn();
      const c = ctx(e);
      if (c.paused && c.phase !== 'tracking') violations.push(`${label}: paused in ${c.phase}`);
    };

    step('pause idle', () => e.pause());
    step('start', () => e.start(TEST_IDENTITY));
    step('pause init', () => e.pause());
    step('reset init', () => e.reset(TEST_IDENTITY));
    step('bag', () => feed(d, e, log.bagInit(1, 100, 0)));
    step('pause init2', () => e.pause());
    step('debounce', () => vi.advanceTimersByTime(600));
    step('pause', () => e.pause());
    step('map', () => feed(d, e, log.zoneTransition(TOWN, MAP)));
    step('reset paused', () => e.reset(TEST_IDENTITY));
    step('resume', () => e.resume());
    step('arcana', () => feed(d, e, log.zoneTransition(MAP, ARCANA_FIGHT)));
    step('pause arcana', () => e.pause());
    step('town', () => feed(d, e, log.zoneTransition(ARCANA_FIGHT, TOWN)));
    step('stop', () => e.stop());
    step('pause after stop', () => e.pause());
    step('restart', () => e.start(TEST_IDENTITY));
    step('pause restart', () => e.pause());
    step('bag again', () => feed(d, e, log.bagInit(1, 100, 0)));
    step('debounce2', () => vi.advanceTimersByTime(600));
    step('pause tracking', () => e.pause());
    step('restart paused', () => e.start(TEST_IDENTITY));

    expect(violations).toEqual([]);
    expect(ctx(e).paused).toBe(false);
  });
});
