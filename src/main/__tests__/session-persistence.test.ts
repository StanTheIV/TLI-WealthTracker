/**
 * Tests for SessionPersistence.onTrackerFinished — buffer routing for the
 * three tracker_finished kinds:
 *   map      -> primary row (parentMapIndex=null), bumps mapIndex.
 *   seasonal (no active map) -> primary standalone row (Sandlord case).
 *   seasonal (active map)    -> overlap row pointing at the parent map's mapIndex.
 *
 * No DB or filesystem — we inspect the buffered rows via discard()-friendly
 * accessors and the autoSave path is exercised via a minimal session-finish
 * event with autosave skipped (no drops, under min duration).
 */
import {describe, it, expect} from 'vitest';
import {SessionPersistence} from '@/main/session-persistence';
import type {EngineEvent} from '@/types/electron';
import type {Engine} from '@/main/engine/engine';
import type {DbSessionMap} from '@/main/db';

function makeEngine(opts: {hasMap: boolean; spends?: Record<string, number>}): Engine {
  return {
    hasActiveMapTracker: () => opts.hasMap,
    getLastMapSpends:    () => opts.spends ?? {},
  } as unknown as Engine;
}

function trackerFinished(
  kind: 'session' | 'map' | 'seasonal',
  drops: Record<number, number>,
  elapsed: number,
  seasonalType?: 'overrealm' | 'sandlord' | 'clockwork' | 'carjack' | 'vorex' | 'dream',
  timestamp = 1_000_000,
): Extract<EngineEvent, {type: 'tracker_finished'}> {
  return {
    type:      'tracker_finished',
    timestamp,
    tracker:   {kind, drops, elapsed, ...(seasonalType ? {seasonalType} : {})},
  };
}

/** Peek at the persistence layer's pending rows for assertion. */
function pendingRows(p: SessionPersistence): DbSessionMap[] {
  return (p as unknown as {_pendingRows: DbSessionMap[]})._pendingRows;
}

describe('SessionPersistence.onTrackerFinished', () => {
  it('buffers a map tracker_finished as a primary map row (mapIndex=1)', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});
    const engine = makeEngine({hasMap: true, spends: {'42': 3}});

    p.onTrackerFinished(trackerFinished('map', {100: 5}, 60_000), engine);

    const rows = pendingRows(p);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      sessionId:      's1',
      mapIndex:       1,
      duration:       60_000,
      drops:          {'100': 5},
      spent:          {'42': 3},
      seasonalType:   null,
      parentMapIndex: null,
    });
  });

  it('buffers a standalone seasonal (no active map) as a primary row', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});
    const engine = makeEngine({hasMap: false});

    p.onTrackerFinished(trackerFinished('seasonal', {200: 1}, 30_000, 'sandlord'), engine);

    const rows = pendingRows(p);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      mapIndex:       1,
      drops:          {'200': 1},
      seasonalType:   'sandlord',
      parentMapIndex: null,
    });
  });

  it('buffers an overlap seasonal (active map) pointing at the parent mapIndex', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});

    // Run a map first so _lastPrimaryMapIndex = 1.
    p.onTrackerFinished(trackerFinished('map', {100: 5}, 60_000), makeEngine({hasMap: true}));

    // Overrealm fires while the map tracker is still active (overlap case).
    p.onTrackerFinished(trackerFinished('seasonal', {300: 2}, 20_000, 'overrealm'), makeEngine({hasMap: true}));

    const rows = pendingRows(p);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({mapIndex: 1, parentMapIndex: null, seasonalType: null});
    expect(rows[1]).toMatchObject({
      mapIndex:       1,
      drops:          {'300': 2},
      seasonalType:   'overrealm',
      parentMapIndex: 1,
    });
  });

  it('mapIndex only advances on primary rows (overlap rows reuse parent mapIndex)', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});

    // map #1, then an overlap, then map #2, then a standalone Sandlord.
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 2}, 70_000), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('seasonal', {500: 1}, 90_000, 'sandlord'), makeEngine({hasMap: false}));

    const rows = pendingRows(p);
    expect(rows.map(r => ({mi: r.mapIndex, st: r.seasonalType, p: r.parentMapIndex}))).toEqual([
      {mi: 1, st: null,        p: null},
      {mi: 1, st: 'overrealm', p: 1},
      {mi: 2, st: null,        p: null},
      {mi: 3, st: 'sandlord',  p: null},
    ]);
  });

  it('discard() resets pending rows and primary-index counter', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    expect(pendingRows(p).length).toBe(2);

    p.discard();

    expect(pendingRows(p).length).toBe(0);
    // Next map after discard should start back at mapIndex=1.
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    expect(pendingRows(p)[0].mapIndex).toBe(1);
  });
});
