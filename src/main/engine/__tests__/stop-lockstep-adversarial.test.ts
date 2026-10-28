/**
 * 4.1 adversarial: the REAL engine event stream is forwarded to engineStore and
 * `selectRunStatus` must follow the engine's own phase / paused state after every
 * operation; stop interplay with units, re-entrancy, interludes and restarts.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {Engine} from '@/main/engine/engine';
import {selectRunStatus, useEngineStore, type RunStatus} from '@/state/engineStore';
import {checkCheckpoints} from '@/test/unit-invariant';
import {OwnerWatcher} from '@/test/owner-invariant';
import {
  ARCANA_FIGHT, MAP, SANDLORD_HUB, TEST_IDENTITY, TOWN,
  createDispatcher, createEngineWithEmit, ctx, feed, log,
} from './seasonal-fixtures';
import {INV, LOOT, rig} from './interlude-fixtures';
import {beginSession, completeInit} from './identity-fixtures';

const typeOf = (e: EngineEvent): string => e.type;
const count  = (evs: EngineEvent[], t: string) => evs.filter(e => e.type === t).length;
const store  = () => useEngineStore.getState();
const status = (): RunStatus => selectRunStatus(store());

/** Engine whose every event also goes to the real store; per-event elapsed watch. */
function lockstep() {
  const events: EngineEvent[] = [];
  const regress: string[] = [];
  let prev = 0;
  let e!: Engine;
  const w = new OwnerWatcher({writer: () => ctx(e).registry.writer(), store: true});
  e = createEngineWithEmit(ev => {
    events.push(ev);
    w.onEmit(ev);
    store().handleEvent(ev);
    const resets = ev.type === 'init_started' || ev.type === 'engine_stopped'
      || (ev.type === 'tracker_started' && ev.tracker.kind === 'session')
      || (ev.type === 'tracker_finished' && ev.tracker.kind === 'session');
    const el = store().sessionElapsed;
    if (!resets && el < prev) regress.push(`${ev.type}: ${prev} -> ${el}`);
    prev = el;
  });
  const d = createDispatcher();
  /** The store's status vs the engine's own state, at a settled point. */
  const sync = (label: string) => {
    const c = ctx(e);
    if (c.phase === 'idle') expect(status(), label).toBe('idle');
    else if (c.phase === 'initializing') expect(status(), label).toBe('initializing');
    else expect(status(), label).toBe(c.paused ? 'paused' : 'running');
    expect(store().phase, label).toBe(c.phase);
  };
  let total = 0;
  return {
    e, d, events, regress, w, sync,
    start:  () => { beginSession(e); sync('start'); },
    init:   () => { completeInit(d, e, INV); sync('init'); },
    go:     (a: string, b: string) => { feed(d, e, log.zoneTransition(a, b)); sync('go'); },
    drop:   (n: number) => { total += n; feed(d, e, log.bagUpdate(1, LOOT, total)); sync('drop'); },
    pause:  () => { e.pause(); sync('pause'); },
    resume: () => { e.resume(); sync('resume'); },
    reset:  () => { e.reset(TEST_IDENTITY); sync('reset'); },
    stop:   () => { e.stop(); sync('stop'); },
  };
}

beforeEach(() => { vi.useFakeTimers(); useEngineStore.getState().reset(); });
afterEach(() => { vi.useRealTimers(); });

describe('store follows the real engine stream', () => {
  it('start, init, pause, drops while paused, resume, reset, stop, restart', () => {
    const t = lockstep();
    t.sync('fresh');
    t.start();
    expect(status()).toBe('initializing');
    t.pause(); // dropped during init
    expect(status()).toBe('initializing');
    t.init();
    expect(status()).toBe('running');

    vi.advanceTimersByTime(3_000);
    t.go(TOWN, MAP);
    t.drop(1);
    vi.advanceTimersByTime(2_000);
    t.pause();
    expect(status()).toBe('paused');
    t.drop(2); // accepted while paused -> session update
    expect(status()).toBe('paused');
    vi.advanceTimersByTime(5_000);
    t.drop(1);
    expect(status()).toBe('paused');
    t.resume();
    expect(status()).toBe('running');
    t.pause();
    t.reset(); // reset while paused keeps paused
    expect(status()).toBe('paused');
    t.resume();
    t.reset(); // reset while running
    expect(status()).toBe('running');
    t.pause();
    t.stop();
    expect(status()).toBe('idle');
    expect(t.events.at(-1)!.type).toBe('engine_stopped');

    t.start(); t.init();
    expect(status()).toBe('running');
    t.stop();
    expect(status()).toBe('idle');
    expect(count(t.events, 'engine_stopped')).toBe(2);
    expect(t.regress).toEqual([]);
    expect(t.w.violations).toEqual([]);
  });

  it('stop during initializing and a second stop: idle, one engine_stopped', () => {
    const t = lockstep();
    t.start();
    t.stop();
    t.stop();
    expect(status()).toBe('idle');
    expect(count(t.events, 'engine_stopped')).toBe(1);
  });

  it('map entered while paused keeps paused', () => {
    const t = lockstep();
    t.start(); t.init();
    t.pause();
    t.go(TOWN, MAP);
    expect(status()).toBe('paused');
    t.resume();
    t.stop();
    expect(t.regress).toEqual([]);
  });

  it('continue a session then stop during init: no tracker_finished, one engine_stopped', () => {
    const t = lockstep();
    beginSession(t.e, {loaded: {sessionId: 'old', name: 'Old', drops: {}, spent: {}, mapTime: 10, mapCount: 2, elapsed: 90} as never});
    t.sync('continue-init');
    expect(status()).toBe('initializing');
    t.stop();
    expect(status()).toBe('idle');
    expect(count(t.events, 'engine_stopped')).toBe(1);
    expect(count(t.events, 'tracker_finished')).toBe(0);
  });

  it('stop inside an interlude and while paused in a Sandlord hub, then restart cleanly', () => {
    const t = lockstep();
    t.start(); t.init();
    t.go(TOWN, MAP);
    t.drop(1);
    t.go(MAP, ARCANA_FIGHT);
    vi.advanceTimersByTime(4_000);
    t.drop(1);
    t.stop();
    expect(status()).toBe('idle');

    t.start(); t.init();
    t.go(TOWN, SANDLORD_HUB);
    vi.advanceTimersByTime(3_000);
    t.pause();
    t.stop();
    expect(status()).toBe('idle');
    expect(t.regress).toEqual([]);
    expect(checkCheckpoints(t.events)).toEqual([]);
    expect(t.w.violations).toEqual([]);
  });

  it('right after a reset: stop is one engine_stopped, last', () => {
    const t = lockstep();
    t.start(); t.init();
    t.reset();
    t.stop();
    expect(t.events.at(-1)!.type).toBe('engine_stopped');
    expect(count(t.events, 'engine_stopped')).toBe(1);
  });
});

describe('stop ordering with finished children', () => {
  it('units, then session tracker_finished, then engine_stopped; invariants hold over stop->start->stop', () => {
    const o = rig();
    o.init();
    o.go(TOWN, MAP);
    o.drop(1);
    o.go(MAP, ARCANA_FIGHT);
    o.adv(5_000);
    o.drop(2);
    o.go(ARCANA_FIGHT, MAP);
    o.adv(2_000);
    o.e.stop();
    const kinds = o.events.map(typeOf);
    const fin = o.events.findIndex(e => e.type === 'tracker_finished' && e.tracker.kind === 'session');
    expect(fin).toBeGreaterThan(-1);
    expect(kinds.lastIndexOf('unit_finished')).toBeLessThan(fin);
    expect(fin).toBe(kinds.length - 2);
    expect(kinds.at(-1)).toBe('engine_stopped');
    expect(count(o.events, 'engine_stopped')).toBe(1);

    beginSession(o.e);
    o.init();
    o.go(TOWN, MAP);
    o.drop(1);
    o.e.stop();
    expect(count(o.events, 'engine_stopped')).toBe(2);
    o.assertClean();
  });
});

describe('re-entrancy: a consumer stops the engine from inside an emit', () => {
  function reentrant(trigger: (ev: EngineEvent) => boolean) {
    const events: EngineEvent[] = [];
    let e!: Engine;
    let fired = false;
    e = createEngineWithEmit(ev => {
      events.push(ev);
      if (!fired && trigger(ev)) { fired = true; e.stop(); }
    });
    return {e, events};
  }

  it('stop called on the session tracker_started: one engine_stopped, last', () => {
    const {e, events} = reentrant(ev => ev.type === 'tracker_started' && ev.tracker.kind === 'session');
    beginSession(e);
    completeInit(createDispatcher(), e, INV);
    expect(count(events, 'engine_stopped')).toBe(1);
    expect(events.at(-1)!.type).toBe('engine_stopped');
  });

  it('stop called on init_started: one engine_stopped, last', () => {
    const {e, events} = reentrant(ev => ev.type === 'init_started');
    beginSession(e);
    expect(count(events, 'engine_stopped')).toBe(1);
    expect(events.at(-1)!.type).toBe('engine_stopped');
  });
});
