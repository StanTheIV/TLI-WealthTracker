/**
 * Test support for the persistence-only `unit_finished` engine event and
 * `SessionPersistence.onEngineEvent`.
 */
import type {AutoSaveOutcome, SessionPersistence} from '@/main/session-persistence';
import type {EngineEvent, SeasonalPhase, SeasonalType, TrackerSnapshot, UnitCheckpoint} from '@/shared/contracts/engine';

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
export function onEngineEvent(p: SessionPersistence, event: EngineEvent): AutoSaveOutcome | null {
  return p.onEngineEvent(event);
}
