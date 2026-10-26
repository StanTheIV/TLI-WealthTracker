/**
 * The overlay's live session state, driven through the real reducer in Node.
 * `sessionSpent` is the session tracker's entry-cost total: it must follow
 * every session snapshot (absent -> {}) and clear with the rest of the state.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import {useEngineStore} from '../engineStore';

const handle = (e: EngineEvent) => useEngineStore.getState().handleEvent(e);
const state = () => useEngineStore.getState() as unknown as {sessionSpent: Record<number, number>; drops: Record<number, number>};

const session = (over: Partial<TrackerSnapshot> = {}): TrackerSnapshot =>
  ({kind: 'session', drops: {}, elapsed: 0, active: true, ...over});

beforeEach(() => {
  useEngineStore.getState().reset();
});

describe('engineStore.sessionSpent', () => {
  it('starts empty', () => {
    expect(state().sessionSpent).toEqual({});
  });

  it('takes spent from a session tracker_started snapshot', () => {
    handle({type: 'tracker_started', tracker: session({spent: {2: 3}}), timestamp: 1});
    expect(state().sessionSpent).toEqual({2: 3});
  });

  it('follows a session tracker_update, replacing (not accumulating) the total', () => {
    handle({type: 'tracker_started', tracker: session(), timestamp: 1});
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 2});
    expect(state().sessionSpent).toEqual({2: 1});
    handle({type: 'tracker_update', tracker: session({spent: {2: 4, 5: 1}}), timestamp: 3});
    expect(state().sessionSpent).toEqual({2: 4, 5: 1});
  });

  it('a session snapshot without spent means {}', () => {
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 1});
    handle({type: 'tracker_update', tracker: session(), timestamp: 2});
    expect(state().sessionSpent).toEqual({});
  });

  it('is set from the final snapshot on tracker_finished', () => {
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 1});
    handle({type: 'tracker_finished', tracker: session({spent: {2: 2}, drops: {1: 9}}), timestamp: 2});
    expect(state().sessionSpent).toEqual({2: 2});
    expect(state().drops).toEqual({1: 9});
  });

  it('ignores spent on map and seasonal snapshots', () => {
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 1});
    handle({type: 'tracker_update', tracker: {kind: 'map', drops: {}, elapsed: 0, active: true, spent: {2: 99}}, timestamp: 2});
    handle({type: 'tracker_update', tracker: {kind: 'seasonal', seasonalType: 'lunaria', drops: {}, elapsed: 0, active: true}, timestamp: 3});
    expect(state().sessionSpent).toEqual({2: 1});
  });

  it('is cleared by init_started', () => {
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 1});
    handle({type: 'init_started'} as EngineEvent);
    expect(state().sessionSpent).toEqual({});
  });

  it('is cleared by reset()', () => {
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 1});
    useEngineStore.getState().reset();
    expect(state().sessionSpent).toEqual({});
  });

  it('does not disturb session drops, which keep accumulating from drop events', () => {
    handle({type: 'tracker_started', tracker: session(), timestamp: 1});
    handle({type: 'drop', itemId: 1, change: 5} as EngineEvent);
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 2});
    expect(state().drops).toEqual({1: 5});
    expect(state().sessionSpent).toEqual({2: 1});
  });
});
