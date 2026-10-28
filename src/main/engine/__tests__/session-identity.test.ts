/**
 * Step 2.1b — the engine stamps the session identity (owned by the service) on
 * the session `tracker_started.sessionMeta = {mapTime, mapCount, sessionId, name,
 * continued}`, for a fresh start, a continue (loadSession) and a reset. The
 * session `tracker_finished.sessionMeta` keeps its `{mapTime, mapCount}` shape.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent} from '@/shared/contracts/engine';
import {
  MAP, TEST_IDENTITY, TOWN, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {
  bootSession, beginSession, metaOf, resetWith, sessionStarts, startWith, type SeedData,
} from './identity-fixtures';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const INV = [{slotId: 1, itemId: 800, quantity: 0}];
const NEW_IDENTITY = {sessionId: 'session-new', name: 'Fresh name'};

const SAVED: SeedData = {
  sessionId: 'session-old', name: 'Old run',
  drops: {800: 3}, dropsBySource: {map: {800: 3}}, spent: {},
  totalTime: 120, mapTime: 30, mapCount: 4,
};

function rig(opts: {loaded?: SeedData; identity?: {sessionId: string; name: string}} = {}) {
  const events: EngineEvent[] = [];
  const e: Engine = createEngine(events);
  const d = createDispatcher();
  bootSession(d, e, INV, opts);
  return {
    e, d, events,
    go: (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
  };
}

describe('Engine.start(identity)', () => {
  it('the session tracker_started carries the identity, continued=false, zero map meta', () => {
    const {events} = rig();
    const starts = sessionStarts(events);
    expect(starts).toHaveLength(1);
    expect(metaOf(starts[0])).toEqual({
      mapTime: 0, mapCount: 0, sessionId: TEST_IDENTITY.sessionId, name: TEST_IDENTITY.name, continued: false,
    });
  });

  it('is stamped at init completion, not at start()', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    beginSession(e, {identity: NEW_IDENTITY});
    expect(sessionStarts(events)).toHaveLength(0);
  });

  it('the identity lives on the engine context while the session runs', () => {
    const {e} = rig({identity: NEW_IDENTITY});
    expect(ctx(e).activeSessionId).toBe('session-new');
    expect(ctx(e).activeSessionName).toBe('Fresh name');
  });

  it('a second run after stop carries ITS identity, not the first one', () => {
    const {e, d, events} = rig();
    e.stop();
    events.length = 0;
    bootSession(d, e, INV, {identity: NEW_IDENTITY});

    const [started] = sessionStarts(events);
    expect(metaOf(started)).toMatchObject({sessionId: 'session-new', name: 'Fresh name', continued: false});
  });

  it('stop clears the identity from the context', () => {
    const {e} = rig();
    e.stop();
    expect(ctx(e).activeSessionId).toBeNull();
    expect(ctx(e).activeSessionName).toBeNull();
  });

  it('the session tracker_finished keeps the {mapTime, mapCount} meta, nothing else', () => {
    const {e, d, events} = rig();
    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000);
    feed(d, e, log.zoneTransition(MAP, TOWN));
    e.stop();

    const fin = events.find(ev => ev.type === 'tracker_finished' && ev.tracker.kind === 'session');
    expect(fin?.type === 'tracker_finished' ? fin.sessionMeta : null).toEqual({mapTime: 10_000, mapCount: 1});
  });
});

describe('Engine.loadSession + start — continue', () => {
  it('tracker_started carries the saved identity, continued=true and the loaded map meta (ms)', () => {
    const {events} = rig({loaded: SAVED});
    const [started] = sessionStarts(events);
    expect(metaOf(started)).toEqual({
      mapTime: 30_000, mapCount: 4, sessionId: 'session-old', name: 'Old run', continued: true,
    });
  });

  it('the identity lives on the context', () => {
    const {e} = rig({loaded: SAVED});
    expect(ctx(e).activeSessionId).toBe('session-old');
    expect(ctx(e).activeSessionName).toBe('Old run');
  });

  it('a fresh run after a stopped continue is NOT continued', () => {
    const {e, d, events} = rig({loaded: SAVED});
    e.stop();
    events.length = 0;
    bootSession(d, e, INV, {identity: NEW_IDENTITY});

    const [started] = sessionStarts(events);
    expect(metaOf(started)).toEqual({
      mapTime: 0, mapCount: 0, sessionId: 'session-new', name: 'Fresh name', continued: false,
    });
  });
});

describe('Engine.reset(identity)', () => {
  it('in town: the new session tracker_started carries the new identity, continued=false', () => {
    const {e, events} = rig();
    const before = events.length;
    resetWith(e, NEW_IDENTITY);

    const starts = sessionStarts(events.slice(before));
    expect(starts).toHaveLength(1);
    expect(metaOf(starts[0])).toMatchObject({sessionId: 'session-new', name: 'Fresh name', continued: false, mapTime: 0, mapCount: 0});
    expect(ctx(e).activeSessionId).toBe('session-new');
    expect(ctx(e).activeSessionName).toBe('Fresh name');
  });

  it('resetting a CONTINUED session yields a fresh, non-continued session', () => {
    const {e, events} = rig({loaded: SAVED});
    const before = events.length;
    resetWith(e, NEW_IDENTITY);

    const [started] = sessionStarts(events.slice(before));
    expect(metaOf(started)).toEqual({
      mapTime: 0, mapCount: 0, sessionId: 'session-new', name: 'Fresh name', continued: false,
    });
  });

  it('mid-map: still the new identity (the map becomes map #1 of the new session)', () => {
    const {e, events, go} = rig();
    go(TOWN, MAP);
    const before = events.length;
    resetWith(e, NEW_IDENTITY);

    const [started] = sessionStarts(events.slice(before));
    expect(metaOf(started)).toMatchObject({sessionId: 'session-new', name: 'Fresh name', continued: false});
    expect(ctx(e).mapCount).toBe(1);
  });

  it('twice in a row: each tracker_started carries its own identity', () => {
    const {e, events} = rig();
    const before = events.length;
    resetWith(e, {sessionId: 'r1', name: 'One'});
    resetWith(e, {sessionId: 'r2', name: 'Two'});

    const metas = sessionStarts(events.slice(before)).map(metaOf);
    expect(metas.map(m => m.sessionId)).toEqual(['r1', 'r2']);
    expect(metas.map(m => m.name)).toEqual(['One', 'Two']);
  });

  it('is a no-op outside tracking: no event, identity untouched (idle)', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    resetWith(e, NEW_IDENTITY);
    expect(events).toEqual([]);
    expect(ctx(e).activeSessionId).toBeNull();
  });

  it('is a no-op while initializing: the pending start keeps its identity', () => {
    const events: EngineEvent[] = [];
    const e = createEngine(events);
    const d = createDispatcher();
    startWith(e, TEST_IDENTITY);
    resetWith(e, NEW_IDENTITY);
    expect(ctx(e).activeSessionId).toBe(TEST_IDENTITY.sessionId);

    feed(d, e, log.bagInit(1, 800, 0));
    vi.advanceTimersByTime(600);
    const [started] = sessionStarts(events);
    expect(metaOf(started)).toMatchObject({sessionId: TEST_IDENTITY.sessionId, name: TEST_IDENTITY.name});
  });
});
