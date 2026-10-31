/**
 * 4.2a store side: `applySnapshot({seq, events})` rebuilds the store from a
 * replay, and a paused session hides frozen loot-window countdowns.
 * `applySnapshot` / `lastSeq` do not exist yet — reached through a local
 * interface so the file typechecks.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import type {WireEngineEvent, SeasonalType, TrackerSnapshot} from '@/shared/contracts/engine';
import {useEngineStore, selectRunStatus} from '@/state/engineStore';

interface SnapshotStore {
  applySnapshot(snapshot: {seq: number; events: WireEngineEvent[]}): void;
  lastSeq: number;
}
const store = () => useEngineStore.getState();
const apply = (seq: number, events: WireEngineEvent[]) => (store() as unknown as SnapshotStore).applySnapshot({seq, events});
const lastSeq = () => (store() as unknown as SnapshotStore).lastSeq;

const T = 1_000;
const snap = (kind: TrackerSnapshot['kind'], over: Partial<TrackerSnapshot> = {}): TrackerSnapshot =>
  ({kind, drops: {}, elapsed: 0, startedAt: T, active: true, ...over});
const seasonal = (seasonalType: SeasonalType, over: Partial<TrackerSnapshot> = {}) =>
  snap('seasonal', {seasonalType, owner: true, ...over});

const started = (tracker: TrackerSnapshot, extra: Partial<Extract<WireEngineEvent, {type: 'tracker_started'}>> = {}): WireEngineEvent =>
  ({type: 'tracker_started', tracker, timestamp: T, ...extra});
const sessionStarted = (over: Partial<TrackerSnapshot> = {}, meta?: {name?: string; continued?: boolean; mapCount?: number; mapTime?: number}): WireEngineEvent =>
  started(snap('session', over), {
    sessionMeta: {sessionId: 'sid', name: meta?.name ?? 'Run', continued: meta?.continued ?? false, mapTime: meta?.mapTime ?? 0, mapCount: meta?.mapCount ?? 0},
  });
const lootStarted = (seasonalType: SeasonalType, deadline: number): WireEngineEvent => ({type: 'loot_window_started', seasonalType, deadline, timestamp: T});
const status = (s: 'running' | 'paused'): WireEngineEvent => ({type: 'session_status', status: s, elapsed: 5_000, timestamp: T});

/** A replay of a mid-run state: tracking, in a map, a seasonal, a window, a warning. */
const REPLAY: WireEngineEvent[] = [
  {type: 'init_started'},
  {type: 'init_complete', itemCount: 0},
  sessionStarted({elapsed: 9_000, drops: {1: 4}, spent: {100: 3}}, {name: 'Old run', continued: true, mapCount: 2, mapTime: 30_000}),
  {type: 'zone_change', from: 'a', to: 'town-x', entering: 'town', timestamp: T},
  started(snap('map', {elapsed: 2_000, drops: {1: 1}})),
  started(seasonal('carjack', {elapsed: 1_000})),
  lootStarted('carjack', 99_000),
  {type: 'map_material_warning', items: [{itemId: 100, quantity: 1}], timestamp: T},
];

beforeEach(() => { store().reset(); });

describe('applySnapshot', () => {
  it('reduces the replay into the store and remembers seq', () => {
    apply(17, REPLAY);
    const s = store();
    expect(lastSeq()).toBe(17);
    expect(s.phase).toBe('tracking');
    expect(selectRunStatus(s)).toBe('running');
    expect(s.sessionElapsed).toBe(9_000);
    expect(s.drops).toEqual({1: 4});
    expect(s.sessionSpent).toEqual({100: 3});
    expect(s.mapCount).toBe(2);
    expect(s.accumulatedMapTime).toBe(30_000);
    expect(s.activeSessionId).toBe('sid');
    expect(s.activeSessionName).toBe('Old run');
    expect(s.currentZone).toBe('town-x');
    expect(s.mapTracker?.elapsed).toBe(2_000);
    expect(s.mapTrackerReceivedAt).not.toBeNull();
    expect([...s.seasonalTrackers.keys()]).toEqual(['carjack']);
    expect(s.seasonalTrackersReceivedAt.has('carjack')).toBe(true);
    expect(s.lowStockWarnings).toEqual([{itemId: 100, quantity: 1}]);
    expect([...s.lootWindowDeadlines]).toEqual([['carjack', 99_000]]);
  });

  it('leaves the feed empty (a reloaded window has no history)', () => {
    apply(1, REPLAY);
    expect(store().feed).toEqual([]);
    // ...while a live event after it is a normal feed entry
    store().handleEvent({type: 'drop', itemId: 1, change: 1, timestamp: T});
    expect(store().feed).toHaveLength(1);
  });

  it('resets EVERYTHING first: stale state, currentZone and activeSession* included', () => {
    const s0 = store();
    s0.handleEvent({type: 'init_started'});
    s0.handleEvent({type: 'init_complete', itemCount: 0});
    s0.handleEvent(sessionStarted({drops: {9: 9}}, {name: 'Stale', continued: true, mapCount: 5, mapTime: 77}));
    s0.handleEvent({type: 'zone_change', from: 'x', to: 'stale-zone', entering: 'town', timestamp: T});
    s0.handleEvent(started(snap('map')));
    s0.handleEvent(started(seasonal('vorex')));
    s0.handleEvent(lootStarted('vorex', 5_000));
    s0.handleEvent({type: 'map_material_warning', items: [{itemId: 5, quantity: 0}], timestamp: T});
    s0.handleEvent({type: 'tracker_update', tracker: snap('session', {drops: {9: 9}}), timestamp: T});

    apply(3, []);
    const s = store();
    expect(lastSeq()).toBe(3);
    expect(s.phase).toBe('idle');
    expect(selectRunStatus(s)).toBe('idle');
    expect(s.drops).toEqual({});
    expect(s.sessionSpent).toEqual({});
    expect(s.mapCount).toBe(0);
    expect(s.currentZone).toBeNull();
    expect(s.mapTracker).toBeNull();
    expect(s.mapTrackerReceivedAt).toBeNull();
    expect(s.seasonalTrackers.size).toBe(0);
    expect(s.seasonalTrackersReceivedAt.size).toBe(0);
    expect(s.sessionElapsed).toBe(0);
    expect(s.sessionReceivedAt).toBeNull();
    expect(s.accumulatedMapTime).toBe(0);
    expect(s.activeSessionId).toBeNull();
    expect(s.activeSessionName).toBeNull();
    expect(s.lowStockWarnings).toEqual([]);
    expect(s.dismissedMaterials.size).toBe(0);
    expect(s.lootWindowDeadlines.size).toBe(0);
    expect(s.feed).toEqual([]);
  });

  it('a second snapshot replaces the first wholesale', () => {
    apply(1, REPLAY);
    apply(2, [{type: 'init_started'}]);
    const s = store();
    expect(lastSeq()).toBe(2);
    expect(s.phase).toBe('initializing');
    expect(s.currentZone).toBeNull();
    expect(s.activeSessionId).toBeNull();
    expect(s.seasonalTrackers.size).toBe(0);
    expect(s.lootWindowDeadlines.size).toBe(0);
    expect(s.lowStockWarnings).toEqual([]);
  });

  it('a paused-session replay shows no frozen window and a paused run', () => {
    apply(4, [
      {type: 'init_started'},
      {type: 'init_complete', itemCount: 0},
      sessionStarted({active: false, elapsed: 5_000}),
      started(seasonal('carjack', {active: false})),
    ]);
    expect(selectRunStatus(store())).toBe('paused');
    expect(store().lootWindowDeadlines.size).toBe(0);
  });
});

describe('loot windows follow the pause', () => {
  const run = () => {
    const s = store();
    s.handleEvent({type: 'init_started'});
    s.handleEvent({type: 'init_complete', itemCount: 0});
    s.handleEvent(sessionStarted());
    s.handleEvent(started(seasonal('carjack')));
    s.handleEvent(started(seasonal('lunaria')));
    s.handleEvent(lootStarted('carjack', 50_000));
    s.handleEvent(lootStarted('lunaria', 60_000));
  };

  it('session_status paused clears every deadline', () => {
    run();
    expect(store().lootWindowDeadlines.size).toBe(2);
    store().handleEvent(status('paused'));
    expect(selectRunStatus(store())).toBe('paused');
    expect(store().lootWindowDeadlines.size).toBe(0);
    // the trackers themselves stay
    expect(store().seasonalTrackers.size).toBe(2);
  });

  it('a session snapshot with active:false clears them too (tracker_update and tracker_started)', () => {
    run();
    store().handleEvent({type: 'tracker_update', tracker: snap('session', {active: false, elapsed: 3_000}), timestamp: T});
    expect(store().lootWindowDeadlines.size).toBe(0);

    store().reset();
    run();
    store().handleEvent(sessionStarted({active: false}));
    expect(store().lootWindowDeadlines.size).toBe(0);
  });

  it('an active session snapshot does not clear them', () => {
    run();
    store().handleEvent({type: 'tracker_update', tracker: snap('session', {elapsed: 3_000}), timestamp: T});
    expect(store().lootWindowDeadlines.size).toBe(2);
  });

  it('resume\'s loot_window_started restores the countdown with the remaining time', () => {
    run();
    store().handleEvent(status('paused'));
    store().handleEvent(status('running'));
    store().handleEvent(lootStarted('carjack', 52_345));
    expect([...store().lootWindowDeadlines]).toEqual([['carjack', 52_345]]);
    expect(selectRunStatus(store())).toBe('running');
  });

  it('a window ended while paused stays gone after resume', () => {
    run();
    store().handleEvent(status('paused'));
    store().handleEvent({type: 'loot_window_ended', seasonalType: 'carjack', timestamp: T});
    store().handleEvent(status('running'));
    expect(store().lootWindowDeadlines.size).toBe(0);
  });
});
