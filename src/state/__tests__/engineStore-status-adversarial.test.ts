/** 4.1 adversarial: out-of-order / duplicate events against the derived run status. */
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import {selectRunStatus, useEngineStore} from '@/state/engineStore';

const handle = (e: EngineEvent) => useEngineStore.getState().handleEvent(e);
const state  = () => useEngineStore.getState();
const status = () => selectRunStatus(state());

const session = (over: Partial<TrackerSnapshot> = {}): TrackerSnapshot =>
  ({kind: 'session', drops: {}, elapsed: 0, startedAt: 0, active: true, ...over});
const meta = {sessionId: 's1', name: 'n', continued: false, mapTime: 0, mapCount: 0};

function boot(): void {
  handle({type: 'init_started'});
  handle({type: 'init_complete', itemCount: 1});
  handle({type: 'tracker_started', tracker: session(), timestamp: 1, sessionMeta: meta});
}
const stopped = () => handle({type: 'engine_stopped', timestamp: 10});

beforeEach(() => { vi.useRealTimers(); useEngineStore.getState().reset(); });

describe('stray events after the run ended', () => {
  it('a second engine_stopped is idempotent and keeps the drops', () => {
    boot();
    handle({type: 'drop', itemId: 5, change: 2, timestamp: 2});
    stopped();
    const before = state();
    stopped();
    expect(status()).toBe('idle');
    expect(state().drops).toEqual({5: 2});
    expect(state().sessionElapsed).toBe(before.sessionElapsed);
  });

  it('a stray session_status / session update after engine_stopped still reads idle', () => {
    boot();
    stopped();
    handle({type: 'session_status', status: 'running', elapsed: 4_000, timestamp: 11});
    expect(status()).toBe('idle');
    expect(state().phase).toBe('idle');
    handle({type: 'tracker_update', tracker: session({elapsed: 5_000}), timestamp: 12});
    expect(status()).toBe('idle');
    handle({type: 'session_status', status: 'paused', elapsed: 4_000, timestamp: 13});
    expect(status()).toBe('idle');
  });

  it('the next run starts clean after stray post-stop events', () => {
    boot();
    stopped();
    handle({type: 'tracker_update', tracker: session({elapsed: 5_000}), timestamp: 12});
    handle({type: 'init_started'});
    expect(status()).toBe('initializing');
    expect(state().sessionElapsed).toBe(0);
    expect(state().sessionReceivedAt).toBeNull();
    expect(state().sessionStatus).toBe('idle');
  });

  it('engine_stopped on a fresh store changes nothing', () => {
    stopped();
    expect(status()).toBe('idle');
    expect(state().phase).toBe('idle');
  });
});

describe('selector edge states', () => {
  it('tracking with no session yet (init_complete before tracker_started) is initializing', () => {
    handle({type: 'init_started'});
    handle({type: 'init_complete', itemCount: 1});
    expect(state().phase).toBe('tracking');
    expect(status()).toBe('initializing');
  });

  it('stop between init_complete and tracker_started goes idle', () => {
    handle({type: 'init_started'});
    handle({type: 'init_complete', itemCount: 1});
    stopped();
    expect(status()).toBe('idle');
  });

  it('a duplicate init_started mid-run (restart without a stop event) goes back to initializing', () => {
    boot();
    handle({type: 'init_started'});
    expect(status()).toBe('initializing');
    expect(state().sessionElapsed).toBe(0);
  });

  it('a map or seasonal update never changes the run status', () => {
    boot();
    handle({type: 'session_status', status: 'paused', elapsed: 1_000, timestamp: 2});
    handle({type: 'tracker_update', tracker: {kind: 'map', drops: {}, elapsed: 500, startedAt: 0, active: true}, timestamp: 3});
    expect(status()).toBe('paused');
  });

  it('session elapsed never regresses across running updates', () => {
    boot();
    let prev = 0;
    for (const el of [100, 500, 500, 2_000]) {
      handle({type: 'tracker_update', tracker: session({elapsed: el}), timestamp: 2});
      expect(state().sessionElapsed).toBeGreaterThanOrEqual(prev);
      prev = state().sessionElapsed;
    }
  });
});
