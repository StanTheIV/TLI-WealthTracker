/**
 * The overlay's live session state, driven through the real reducer in Node.
 * `sessionSpent` is the session tracker's entry-cost total: it must follow
 * every session snapshot (absent -> {}) and clear with the rest of the state.
 */
import {beforeEach, describe, expect, it} from 'vitest';
import type {EngineEvent, SessionStartMeta, TrackerSnapshot} from '@/shared/contracts/engine';
import {useEngineStore} from '../engineStore';

const handle = (e: EngineEvent) => useEngineStore.getState().handleEvent(e);
const state = () => useEngineStore.getState() as unknown as {sessionSpent: Record<number, number>; drops: Record<number, number>};

const session = (over: Partial<TrackerSnapshot> = {}): TrackerSnapshot =>
  ({kind: 'session', drops: {}, elapsed: 0, startedAt: 0, active: true, ...over});

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
    handle({type: 'tracker_update', tracker: {kind: 'map', drops: {}, elapsed: 0, startedAt: 0, active: true, spent: {2: 99}}, timestamp: 2});
    handle({type: 'tracker_update', tracker: {kind: 'seasonal', seasonalType: 'lunaria', drops: {}, elapsed: 0, startedAt: 0, active: true}, timestamp: 3});
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

describe('engineStore live session state, adversarial', () => {
  const full = () => useEngineStore.getState();
  const drop = (itemId: number, change: number) => handle({type: 'drop', itemId, change} as EngineEvent);

  it('a continued session seeds drops, spent, map count and map time from tracker_started, then keeps accumulating', () => {
    handle({
      type: 'tracker_started', timestamp: 1,
      tracker: session({drops: {1: 100, 2: -3}, spent: {2: 4}}),
      sessionMeta: {mapCount: 7, mapTime: 12345},
    } as unknown as EngineEvent);
    expect(state().drops).toEqual({1: 100, 2: -3});
    expect(state().sessionSpent).toEqual({2: 4});
    expect(full().mapCount).toBe(7);
    expect(full().accumulatedMapTime).toBe(12345);
    drop(1, 5); drop(2, -1); drop(9, 2);
    expect(state().drops).toEqual({1: 105, 2: -4, 9: 2});
    expect(state().sessionSpent).toEqual({2: 4});
  });

  it('never mutates the snapshot it was seeded from (drops and spent are copied or replaced, not edited)', () => {
    const tracker = session({drops: {1: 1}, spent: {2: 1}});
    handle({type: 'tracker_started', tracker, timestamp: 1});
    drop(1, 10);
    handle({type: 'tracker_update', tracker: session({spent: {2: 2}}), timestamp: 2});
    expect(tracker.drops).toEqual({1: 1});
    expect(tracker.spent).toEqual({2: 1});
  });

  it('a second session tracker_started (Engine.reset) re-seeds drops and spent, discarding the accumulation', () => {
    handle({type: 'tracker_started', tracker: session({spent: {2: 1}}), timestamp: 1});
    drop(1, 50);
    handle({type: 'tracker_started', tracker: session({drops: {}, spent: {2: 3}}), timestamp: 2});
    expect(state().drops).toEqual({});
    expect(state().sessionSpent).toEqual({2: 3});
  });

  it('reset mid-map keeps the live map tracker and takes the carried entry cost on the new session snapshot', () => {
    handle({type: 'tracker_started', tracker: session(), timestamp: 1});
    handle({type: 'tracker_started', tracker: {kind: 'map', drops: {1: 9}, elapsed: 5, startedAt: 0, active: true, spent: {2: 1}}, timestamp: 2});
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 3});
    drop(1, 9);
    // Engine.reset while the map is running: a fresh session snapshot carrying the map's cost.
    handle({type: 'tracker_started', tracker: session({drops: {}, spent: {2: 1}}), timestamp: 4});
    expect(state().drops).toEqual({});
    expect(state().sessionSpent).toEqual({2: 1});
    expect(full().mapTracker?.drops).toEqual({1: 9});
    expect(full().mapTracker?.spent).toEqual({2: 1});
  });

  it('a map tracker_started or tracker_update never writes sessionSpent, with or without a session', () => {
    handle({type: 'tracker_started', tracker: {kind: 'map', drops: {}, elapsed: 0, startedAt: 0, active: true, spent: {2: 7}}, timestamp: 1});
    expect(state().sessionSpent).toEqual({});
    handle({type: 'tracker_update', tracker: {kind: 'map', drops: {}, elapsed: 1, startedAt: 0, active: true, spent: {2: 8}}, timestamp: 2});
    expect(state().sessionSpent).toEqual({});
    handle({type: 'tracker_finished', tracker: {kind: 'map', drops: {}, elapsed: 1, startedAt: 0, active: false, spent: {2: 8}}, timestamp: 3});
    expect(state().sessionSpent).toEqual({});
  });

  it('a drop after a session tracker_update keeps sessionSpent, and a later update replaces it', () => {
    handle({type: 'tracker_started', tracker: session(), timestamp: 1});
    handle({type: 'tracker_update', tracker: session({spent: {2: 2}}), timestamp: 2});
    drop(1, 3);
    expect(state().sessionSpent).toEqual({2: 2});
    expect(state().drops).toEqual({1: 3});
    handle({type: 'tracker_update', tracker: session({spent: {2: 2, 5: 1}, drops: {1: 999}}), timestamp: 3});
    expect(state().sessionSpent).toEqual({2: 2, 5: 1});
    expect(state().drops).toEqual({1: 3});   // a session update never touches drops
  });

  it('a seasonal tracker never writes sessionSpent or drops', () => {
    handle({type: 'tracker_update', tracker: session({spent: {2: 1}}), timestamp: 1});
    drop(1, 1);
    handle({type: 'tracker_started', tracker: {kind: 'seasonal', seasonalType: 'lunaria', drops: {1: 50}, elapsed: 0, startedAt: 0, active: true, spent: {2: 50}}, timestamp: 2});
    expect(state().sessionSpent).toEqual({2: 1});
    expect(state().drops).toEqual({1: 1});
  });

  it('negative drop events reduce and can drive an item below zero; a zero-sum item stays as a key', () => {
    drop(1, 5); drop(1, -5); drop(2, -2);
    expect(state().drops).toEqual({1: 0, 2: -2});
  });

  it('init_started wipes drops and spent even after a continued session', () => {
    handle({type: 'tracker_started', tracker: session({drops: {1: 5}, spent: {2: 1}}), timestamp: 1});
    handle({type: 'init_started'} as EngineEvent);
    expect(state().drops).toEqual({});
    expect(state().sessionSpent).toEqual({});
  });
});

describe('engineStore active session identity and sessionsVersion (2.1d)', () => {
  const ident = () => useEngineStore.getState();
  const meta = (over: Partial<SessionStartMeta> = {}): SessionStartMeta =>
    ({sessionId: 's1', name: 'Alpha', mapTime: 0, mapCount: 0, continued: false, ...over});
  const startSession = (m: SessionStartMeta) =>
    handle({type: 'tracker_started', tracker: session(), timestamp: 1, sessionMeta: m});
  const finishSession = () => handle({type: 'tracker_finished', tracker: session({active: false}), timestamp: 9});
  const saved = (sessionId: string, deleted?: true) =>
    handle({type: 'session_saved', sessionId, ...(deleted ? {deleted} : {})});

  it('starts with no active session and sessionsVersion 0', () => {
    expect(ident().activeSessionId).toBeNull();
    expect(ident().activeSessionName).toBeNull();
    expect(ident().sessionsVersion).toBe(0);
  });

  it('a fresh session sets activeSessionId but leaves the name null', () => {
    startSession(meta({sessionId: 'fresh', name: 'Fresh', continued: false}));
    expect(ident().activeSessionId).toBe('fresh');
    expect(ident().activeSessionName).toBeNull();
  });

  it('a continued session sets both activeSessionId and activeSessionName', () => {
    startSession(meta({sessionId: 'old', name: 'My Run', continued: true}));
    expect(ident().activeSessionId).toBe('old');
    expect(ident().activeSessionName).toBe('My Run');
  });

  it('the session tracker_finished clears id and name', () => {
    startSession(meta({sessionId: 'old', name: 'My Run', continued: true}));
    finishSession();
    expect(ident().activeSessionId).toBeNull();
    expect(ident().activeSessionName).toBeNull();
  });

  it('init_started no longer wipes the name (it arrives with tracker_started, after init_started)', () => {
    startSession(meta({sessionId: 'old', name: 'My Run', continued: true}));
    handle({type: 'init_started'});
    expect(ident().activeSessionName).toBe('My Run');
    expect(ident().activeSessionId).toBe('old');
  });

  it('map and seasonal tracker_started/finished do not touch id or name', () => {
    startSession(meta({sessionId: 'old', name: 'My Run', continued: true}));
    handle({type: 'tracker_started', tracker: {kind: 'map', drops: {}, elapsed: 0, startedAt: 0, active: true}, timestamp: 2});
    handle({type: 'tracker_started', tracker: {kind: 'seasonal', seasonalType: 'lunaria', drops: {}, elapsed: 0, startedAt: 0, active: true}, timestamp: 3});
    expect(ident().activeSessionId).toBe('old');
    expect(ident().activeSessionName).toBe('My Run');
    handle({type: 'tracker_finished', tracker: {kind: 'seasonal', seasonalType: 'lunaria', drops: {}, elapsed: 0, startedAt: 0, active: false}, timestamp: 4});
    handle({type: 'tracker_finished', tracker: {kind: 'map', drops: {}, elapsed: 0, startedAt: 0, active: false}, timestamp: 5});
    expect(ident().activeSessionId).toBe('old');
    expect(ident().activeSessionName).toBe('My Run');
  });

  it('sessionsVersion bumps on every session_saved, repeats and deleted included', () => {
    saved('a');
    expect(ident().sessionsVersion).toBe(1);
    saved('a');
    expect(ident().sessionsVersion).toBe(2);
    saved('b', true);
    expect(ident().sessionsVersion).toBe(3);
  });

  it('sessionsVersion survives init_started and session finish (monotonic)', () => {
    saved('a');
    handle({type: 'init_started'});
    startSession(meta());
    finishSession();
    expect(ident().sessionsVersion).toBe(1);
    saved('a');
    expect(ident().sessionsVersion).toBe(2);
  });

  it('a Reset sequence lands on the new id with no name and a bumped version', () => {
    startSession(meta({sessionId: 'old', name: 'My Run', continued: true}));
    handle({type: 'tracker_started', tracker: {kind: 'seasonal', seasonalType: 'lunaria', drops: {}, elapsed: 0, startedAt: 0, active: true}, timestamp: 2});
    saved('old', true);
    handle({type: 'tracker_finished', tracker: {kind: 'seasonal', seasonalType: 'lunaria', drops: {}, elapsed: 0, startedAt: 0, active: false}, timestamp: 3});
    handle({type: 'tracker_finished', tracker: {kind: 'map', drops: {}, elapsed: 0, startedAt: 0, active: false}, timestamp: 4});
    startSession(meta({sessionId: 'new', name: 'New', continued: false}));
    expect(ident().activeSessionId).toBe('new');
    expect(ident().activeSessionName).toBeNull();
    expect(ident().sessionsVersion).toBe(1);
  });

  it('reset() clears id and name', () => {
    startSession(meta({sessionId: 'old', name: 'My Run', continued: true}));
    useEngineStore.getState().reset();
    expect(ident().activeSessionId).toBeNull();
    expect(ident().activeSessionName).toBeNull();
  });

  it('the superseded API is gone', () => {
    const s = useEngineStore.getState() as unknown as Record<string, unknown>;
    expect(s.setActiveSessionName).toBeUndefined();
    expect('lastSavedSessionId' in s).toBe(false);
  });
});
