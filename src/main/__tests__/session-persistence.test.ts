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
import type {EngineEvent, SeasonalPhase, SeasonalType} from '@/types/electron';
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
  seasonalType?: SeasonalType,
  timestamp = 1_000_000,
  phase?: SeasonalPhase,
): Extract<EngineEvent, {type: 'tracker_finished'}> {
  return {
    type:      'tracker_finished',
    timestamp,
    tracker:   {kind, drops, elapsed, active: true, ...(seasonalType ? {seasonalType} : {}), ...(phase ? {phase} : {})},
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

  it('a standalone seasonal keeps its entry cost (no map row exists to carry it)', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});
    const engine = makeEngine({hasMap: false, spends: {'42': 2}});

    p.onTrackerFinished(trackerFinished('seasonal', {200: 1}, 30_000, 'sandlord'), engine);

    expect(pendingRows(p)[0].spent).toEqual({'42': 2});
  });

  it('an overlap seasonal records no spend — its parent map row owns the cost', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});
    const engine = makeEngine({hasMap: true, spends: {'42': 2}});

    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), engine);
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), engine);

    const rows = pendingRows(p);
    const map     = rows.find(r => r.seasonalType === null)!;
    const overlap = rows.find(r => r.seasonalType === 'overrealm')!;
    expect(map.spent).toEqual({'42': 2});
    expect(overlap.spent).toEqual({});
  });

  it('buffers an overlap seasonal (active map) pointing at the parent mapIndex', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});

    // finishAll() emits the seasonal first, while the map tracker is still live.
    p.onTrackerFinished(trackerFinished('seasonal', {300: 2}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 5}, 60_000), makeEngine({hasMap: true}));

    const rows = pendingRows(p);
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.seasonalType === null)).toMatchObject({
      mapIndex: 1, parentMapIndex: null,
    });
    expect(rows.find(r => r.seasonalType === 'overrealm')).toMatchObject({
      mapIndex:       1,
      drops:          {'300': 2},
      parentMapIndex: 1,
    });
  });

  it('mapIndex only advances on primary rows (overlap rows reuse parent mapIndex)', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});

    // map #1 (bare), then map #2 with an overlap, then a standalone Sandlord.
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 2}, 70_000), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('seasonal', {500: 1}, 90_000, 'sandlord'), makeEngine({hasMap: false}));

    const rows = pendingRows(p);
    expect(rows.map(r => ({mi: r.mapIndex, st: r.seasonalType, p: r.parentMapIndex}))).toEqual([
      {mi: 1, st: null,        p: null},
      {mi: 2, st: null,        p: null},
      {mi: 2, st: 'overrealm', p: 2},
      {mi: 3, st: 'sandlord',  p: null},
    ]);
  });

  it("carries a snapshot's phase onto the buffered row (in-map sandlord)", () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});

    // The in-map coin tile finishes first, then the map it ran in.
    p.onTrackerFinished(
      trackerFinished('seasonal', {200: 4}, 15_000, 'sandlord', 1_000_000, 'map'),
      makeEngine({hasMap: true}),
    );
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));

    const rows = pendingRows(p);
    expect(rows.find(r => r.seasonalType === null)!.phase).toBe(null);
    expect(rows.find(r => r.seasonalType === 'sandlord')).toMatchObject({
      mapIndex:       1,
      parentMapIndex: 1,
      phase:          'map',
    });
  });

  it("carries phase 'hub' onto a standalone sandlord row", () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});

    p.onTrackerFinished(
      trackerFinished('seasonal', {200: 1}, 30_000, 'sandlord', 1_000_000, 'hub'),
      makeEngine({hasMap: false}),
    );

    expect(pendingRows(p)[0]).toMatchObject({
      mapIndex:       1,
      seasonalType:   'sandlord',
      parentMapIndex: null,
      phase:          'hub',
    });
  });

  it('a snapshot without phase buffers phase null (non-sandlord seasonals, map rows)', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});

    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));

    expect(pendingRows(p).map(r => r.phase)).toEqual([null, null]);
  });

  // ZoneHandler's town path calls registry.finishAll(), which finishes every
  // seasonal BEFORE the map tracker. So for an in-map mechanic the seasonal's
  // tracker_finished always arrives while `_lastPrimaryMapIndex` still names the
  // PREVIOUS map — the map it actually ran in has not been buffered yet.
  it('attaches an in-map seasonal to the map it ran in, not the previous one', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});
    const engine = makeEngine({hasMap: true});

    // Map 1 completes cleanly, no seasonals.
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), engine);
    // Map 2 runs a Hunting arena. finishAll() emits the seasonal first.
    p.onTrackerFinished(trackerFinished('seasonal', {10054: 2}, 5_000, 'hunting'), engine);
    p.onTrackerFinished(trackerFinished('map', {10054: 2}, 60_000), engine);

    const rows    = pendingRows(p);
    const hunting = rows.find(r => r.seasonalType === 'hunting')!;
    const mapTwo  = rows.filter(r => r.seasonalType === null)[1];

    // The hunting run's loot is in map 2's row, so it must point at map 2.
    expect(mapTwo.drops['10054']).toBe(2);
    expect(hunting.parentMapIndex).toBe(mapTwo.mapIndex);
  });

  it('discard() drops staged overlaps whose parent map never arrived', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    expect(pendingRows(p).length).toBe(0); // staged, not yet buffered

    p.discard();
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));

    // The discarded overlap must not resurface when the next map row lands.
    expect(pendingRows(p).length).toBe(1);
    expect(pendingRows(p)[0].seasonalType).toBe(null);
  });

  it('discard() resets pending rows and primary-index counter', () => {
    const p = new SessionPersistence({sessionId: 's1', sessionName: null, isOverride: false});
    p.onTrackerFinished(trackerFinished('seasonal', {300: 1}, 20_000, 'overrealm'), makeEngine({hasMap: true}));
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    expect(pendingRows(p).length).toBe(2);

    p.discard();

    expect(pendingRows(p).length).toBe(0);
    // Next map after discard should start back at mapIndex=1.
    p.onTrackerFinished(trackerFinished('map', {100: 1}, 60_000), makeEngine({hasMap: true}));
    expect(pendingRows(p)[0].mapIndex).toBe(1);
  });
});
