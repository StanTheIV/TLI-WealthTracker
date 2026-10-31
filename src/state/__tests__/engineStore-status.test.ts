/**
 * 4.1b: the run status is DERIVED from engineStore (`selectRunStatus`), not held
 * by TrackingContext. phase idle -> idle, initializing -> initializing, tracking ->
 * sessionStatus. `engine_stopped` is the one signal that every stop happened.
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {WireEngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import {type RunStatus, selectRunStatus, useEngineStore} from '@/state/engineStore';

const handle = (e: WireEngineEvent) => useEngineStore.getState().handleEvent(e);
const state  = () => useEngineStore.getState();
const status = (): RunStatus => selectRunStatus(state());

const NOW = 1_700_000_000_000;

const session = (over: Partial<TrackerSnapshot> = {}): TrackerSnapshot =>
  ({kind: 'session', drops: {}, elapsed: 0, startedAt: 0, active: true, ...over});

const initStarted  = () => handle({type: 'init_started'});
const initComplete = () => handle({type: 'init_complete', itemCount: 1});
const started = (over: Partial<TrackerSnapshot> = {}) =>
  handle({type: 'tracker_started', tracker: session(over), timestamp: 1,
    sessionMeta: {sessionId: 's1', name: 'n', continued: false, mapTime: 0, mapCount: 0}});
const update = (over: Partial<TrackerSnapshot> = {}) =>
  handle({type: 'tracker_update', tracker: session(over), timestamp: 2});
const sessionStatus = (st: 'running' | 'paused', elapsed: number) =>
  handle({type: 'session_status', status: st, elapsed, timestamp: 3});
const finished = (over: Partial<TrackerSnapshot> = {}) =>
  handle({type: 'tracker_finished', tracker: session(over), timestamp: 9});
const engineStopped = () => handle({type: 'engine_stopped', timestamp: 10});

/** init -> baseline: a running session. */
function boot(): void {
  initStarted();
  initComplete();
  started();
}

beforeEach(() => {
  vi.useRealTimers();
  useEngineStore.getState().reset();
});

describe('selectRunStatus', () => {
  it('is idle on a fresh store', () => {
    expect(status()).toBe('idle');
  });

  it('is initializing from init_started, with the raw status still idle', () => {
    initStarted();
    expect(status()).toBe('initializing');
    expect(state().phase).toBe('initializing');
    expect(state().sessionStatus).toBe('idle');
  });

  it('is derived from phase + sessionStatus, not stored', () => {
    useEngineStore.setState({phase: 'tracking', sessionStatus: 'paused'});
    expect(status()).toBe('paused');
    useEngineStore.setState({phase: 'tracking', sessionStatus: 'running'});
    expect(status()).toBe('running');
    useEngineStore.setState({phase: 'initializing', sessionStatus: 'running'});
    expect(status()).toBe('initializing');
    useEngineStore.setState({phase: 'idle', sessionStatus: 'running'});
    expect(status()).toBe('idle');
  });
});

describe('derived status across a full run', () => {
  it('init -> running -> pause -> update while paused (stays paused) -> resume -> stop -> idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    initStarted();
    expect(status()).toBe('initializing');

    initComplete();
    started({elapsed: 0});
    expect(status()).toBe('running');
    expect(state().phase).toBe('tracking');

    vi.setSystemTime(NOW + 5_000);
    sessionStatus('paused', 5_000);
    expect(status()).toBe('paused');
    expect(state().sessionElapsed).toBe(5_000);

    // A drop accepted while paused re-emits the session snapshot (active:false).
    vi.setSystemTime(NOW + 6_000);
    update({elapsed: 5_000, active: false, drops: {1: 1}});
    expect(status()).toBe('paused');
    expect(state().sessionElapsed).toBe(5_000);
    expect(state().sessionReceivedAt).toBe(NOW + 6_000);

    vi.setSystemTime(NOW + 7_000);
    sessionStatus('running', 5_000);
    expect(status()).toBe('running');

    finished({elapsed: 8_000, drops: {1: 1}});
    engineStopped();
    expect(status()).toBe('idle');
    expect(state().phase).toBe('idle');
  });

  it('a running update keeps running', () => {
    boot();
    update({elapsed: 1_000, active: true});
    expect(status()).toBe('running');
  });
});

describe('stop during initializing', () => {
  it('init_started -> engine_stopped -> idle, phase idle, run state cleared', () => {
    initStarted();
    expect(status()).toBe('initializing');
    engineStopped();
    expect(status()).toBe('idle');
    const s = state();
    expect(s.phase).toBe('idle');
    expect(s.sessionStatus).toBe('idle');
    expect(s.sessionElapsed).toBe(0);
    expect(s.sessionReceivedAt).toBeNull();
    expect(s.accumulatedMapTime).toBe(0);
    expect(s.activeSessionId).toBeNull();
    expect(s.activeSessionName).toBeNull();
  });
});

describe('session snapshots drive the status (no forced running)', () => {
  it('tracker_started with active:false -> paused', () => {
    initStarted();
    initComplete();
    started({active: false, elapsed: 2_000});
    expect(status()).toBe('paused');
    expect(state().sessionStatus).toBe('paused');
  });

  it('tracker_update with active:false flips running -> paused; active:true flips back', () => {
    boot();
    update({active: false, elapsed: 1_000});
    expect(status()).toBe('paused');
    update({active: true, elapsed: 1_000});
    expect(status()).toBe('running');
  });

  it('reset while paused: tracker_started then session_status paused -> paused', () => {
    boot();
    sessionStatus('paused', 4_000);
    expect(status()).toBe('paused');
    // Engine.reset: a fresh session tracker_started, then session_status (paused state kept).
    started({elapsed: 0, active: true});
    sessionStatus('paused', 0);
    expect(status()).toBe('paused');
    expect(state().sessionElapsed).toBe(0);
  });

  it('reset while running stays running with elapsed 0', () => {
    boot();
    started({elapsed: 0});
    sessionStatus('running', 0);
    expect(status()).toBe('running');
    expect(state().sessionElapsed).toBe(0);
  });
});

describe('elapsed / receivedAt follow each session event', () => {
  it('tracker_started, tracker_update and session_status each set elapsed and receivedAt', () => {
    vi.useFakeTimers();
    initStarted();
    initComplete();

    vi.setSystemTime(NOW + 1_000);
    started({elapsed: 100});
    expect(state().sessionElapsed).toBe(100);
    expect(state().sessionReceivedAt).toBe(NOW + 1_000);

    vi.setSystemTime(NOW + 2_000);
    update({elapsed: 250});
    expect(state().sessionElapsed).toBe(250);
    expect(state().sessionReceivedAt).toBe(NOW + 2_000);

    vi.setSystemTime(NOW + 3_000);
    sessionStatus('paused', 400);
    expect(state().sessionElapsed).toBe(400);
    expect(state().sessionReceivedAt).toBe(NOW + 3_000);
  });

  it('a continued session starts from its snapshot elapsed', () => {
    initStarted();
    initComplete();
    started({elapsed: 90_000});
    expect(state().sessionElapsed).toBe(90_000);
    expect(status()).toBe('running');
  });
});

describe('engine_stopped', () => {
  it('after the session tracker_finished: idle, same reset block, drops kept', () => {
    boot();
    handle({type: 'map_ended', elapsed: 7_000, timestamp: 4});
    update({elapsed: 8_000, drops: {1: 3}});
    finished({elapsed: 8_000, drops: {1: 3}});
    engineStopped();
    const s = state();
    expect(status()).toBe('idle');
    expect(s.phase).toBe('idle');
    expect(s.sessionStatus).toBe('idle');
    expect(s.sessionElapsed).toBe(0);
    expect(s.sessionReceivedAt).toBeNull();
    expect(s.accumulatedMapTime).toBe(0);
    expect(s.activeSessionId).toBeNull();
    expect(s.activeSessionName).toBeNull();
    expect(s.drops).toEqual({1: 3});
  });

  it('on its own (no tracker_finished) resets a paused run and keeps the drops', () => {
    boot();
    handle({type: 'drop', itemId: 5, change: 2, timestamp: 4});
    handle({type: 'map_ended', elapsed: 7_000, timestamp: 5});
    sessionStatus('paused', 3_000);
    expect(status()).toBe('paused');

    engineStopped();
    const s = state();
    expect(status()).toBe('idle');
    expect(s.phase).toBe('idle');
    expect(s.sessionElapsed).toBe(0);
    expect(s.sessionReceivedAt).toBeNull();
    expect(s.accumulatedMapTime).toBe(0);
    expect(s.activeSessionId).toBeNull();
    expect(s.drops).toEqual({5: 2});
  });

  it('the next run starts clean: init_started clears the kept drops', () => {
    boot();
    handle({type: 'drop', itemId: 5, change: 2, timestamp: 4});
    engineStopped();
    initStarted();
    expect(status()).toBe('initializing');
    expect(state().drops).toEqual({});
  });
});
