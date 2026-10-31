/**
 * Test support for the persistence-only `unit_finished` engine event and
 * `SessionPersistence.onEngineEvent`.
 */
import {SessionPersistence, type PersistOutcome, type SessionMeta, type SessionPersistenceDeps} from '@/main/session-persistence';
import type {EngineEvent, SeasonalPhase, SeasonalType, SessionStartMeta, Source, TrackerSnapshot, UnitCheckpoint} from '@/shared/contracts/engine';

export type UnitFinishedEvent = Extract<EngineEvent, {type: 'unit_finished'}>;

/** The engine events that are `unit_finished`, in emission order. */
export function unitsOf(events: ReadonlyArray<EngineEvent>): UnitFinishedEvent[] {
  return events.filter((e): e is UnitFinishedEvent => e.type === 'unit_finished');
}

/** Index of each event in `events` that is a `unit_finished`. */
export function unitIndexes(events: ReadonlyArray<EngineEvent>): number[] {
  return events.flatMap((e, i) => (e.type === 'unit_finished' ? [i] : []));
}

export interface SnapOpts {
  seasonalType?: SeasonalType;
  phase?:        SeasonalPhase;
  spent?:        Record<number, number>;
  /** The tracker's real start (ms epoch); defaults to 0. */
  startedAt?:    number;
}

export function snap(kind: TrackerSnapshot['kind'], drops: Record<number, number>, elapsed: number, opts: SnapOpts = {}): TrackerSnapshot {
  return {
    kind, drops, elapsed, startedAt: opts.startedAt ?? 0, active: true,
    ...(opts.seasonalType ? {seasonalType: opts.seasonalType} : {}),
    ...(opts.phase        ? {phase: opts.phase}               : {}),
    ...(opts.spent        ? {spent: opts.spent}               : {}),
  };
}

/** A unit event built by hand: `primary` is a map or a standalone seasonal.
 *  `checkpoint` defaults to an empty session (no maps yet). */
export function unitFinished(
  primary: TrackerSnapshot,
  overlaps: Array<{tracker: TrackerSnapshot; timestamp?: number}> = [],
  timestamp = 1_000_000,
  checkpoint: UnitCheckpoint = {session: snap('session', {}, 0), mapTime: 0, mapCount: 0},
): UnitFinishedEvent {
  return {
    type: 'unit_finished',
    tracker: primary,
    overlaps: overlaps.map(o => ({tracker: o.tracker, timestamp: o.timestamp ?? timestamp})),
    timestamp,
    checkpoint,
  };
}

/** Feed any engine event to `SessionPersistence.onEngineEvent`. */
export function onEngineEvent(p: SessionPersistence, event: EngineEvent): PersistOutcome | null {
  return p.onEngineEvent(event);
}

/** A unit's checkpoint: the session state as of the unit. `drops`/`spent`/
 *  `dropsBySource` are the SESSION's running totals, `elapsed` its ms clock. */
export function checkpointOf(opts: {
  drops?:         Record<number, number>;
  spent?:         Record<number, number>;
  dropsBySource?: Partial<Record<Source, Record<number, number>>>;
  elapsed?:       number;
  mapTime?:       number;
  mapCount?:      number;
} = {}): UnitCheckpoint {
  const session = snap('session', opts.drops ?? {}, opts.elapsed ?? 0, {spent: opts.spent});
  if (opts.dropsBySource) session.dropsBySource = opts.dropsBySource as Record<Source, Record<number, number>>;
  return {session, mapTime: opts.mapTime ?? 0, mapCount: opts.mapCount ?? 0};
}

/** The session `tracker_started` as the engine emits it. */
export function sessionStarted(meta: Partial<SessionStartMeta> = {}, timestamp = 900_000): Extract<EngineEvent, {type: 'tracker_started'}> {
  return {
    type: 'tracker_started', tracker: snap('session', {}, 0), timestamp,
    sessionMeta: {sessionId: 's1', name: 'Run', continued: false, mapTime: 0, mapCount: 0, ...meta},
  };
}

/** The session `tracker_finished` as the engine emits it at Stop. */
export function sessionFinished(opts: {
  drops?:         Record<number, number>;
  spent?:         Record<number, number>;
  dropsBySource?: Partial<Record<Source, Record<number, number>>>;
  elapsed?:       number;
  mapTime?:       number;
  mapCount?:      number;
  timestamp?:     number;
} = {}): Extract<EngineEvent, {type: 'tracker_finished'}> {
  const tracker = snap('session', opts.drops ?? {}, opts.elapsed ?? 60_000, {spent: opts.spent});
  if (opts.dropsBySource) tracker.dropsBySource = opts.dropsBySource as Record<Source, Record<number, number>>;
  return {
    type: 'tracker_finished', timestamp: opts.timestamp ?? 1_000_000, tracker,
    sessionMeta: {mapTime: opts.mapTime ?? 50_000, mapCount: opts.mapCount ?? 1},
  };
}

/** A persistence for session `s1` ("Run", fresh, from map #1) unless `meta` says otherwise. */
export function makePersistence(deps: SessionPersistenceDeps, meta: Partial<SessionMeta> = {}): SessionPersistence {
  return new SessionPersistence({sessionId: 's1', name: 'Run', continued: false, nextMapIndex: 1, ...meta}, deps);
}
