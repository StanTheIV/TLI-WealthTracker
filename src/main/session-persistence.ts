import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {EngineEvent, Source, TrackerSnapshot, UnitCheckpoint} from '@/shared/contracts/engine';
import type {SqliteSessionStore} from './db/session-store';
import {log} from './logger';

/** The run one SessionPersistence writes. */
export interface SessionMeta {
  /** Fresh (service-generated) or the id of the continued session. */
  sessionId:    string;
  /** The name a fresh session is inserted with; a continued one keeps its stored name. */
  name:         string;
  /** True when the run appends to a saved session (reopened, not inserted). */
  continued:    boolean;
  /** mapIndex of the run's first unit: 1 for a fresh session, the stored max + 1 when continued. */
  nextMapIndex: number;
}

/** What one consumed event wrote: the session saved (inserted, reopened,
 *  updated, closed) or deleted (an empty run at Stop). */
export type PersistOutcome = {savedId: string} | {deletedId: string};

/** Current price of each requested item id the reader knows. */
export type PriceReader = (ids: ReadonlySet<string>) => Record<string, number>;

export interface SessionPersistenceDeps {
  store:      SqliteSessionStore;
  readPrices: PriceReader;
}

/** A run shorter than this with nothing in it is not worth keeping. */
export const MIN_SAVE_DURATION_MS = 30_000;

/** The empty-run rule, shared by Stop and the startup crash-close: under
 *  30 s, no drops, no spent (a consumed entry cost is content) and no rows. */
export function isEmptyRun(run: {
  elapsedMs: number;
  drops:     Record<string, number>;
  spent:     Record<string, number>;
  hasRows:   boolean;
}): boolean {
  return run.elapsedMs < MIN_SAVE_DURATION_MS
    && Object.keys(run.drops).length === 0
    && Object.keys(run.spent).length === 0
    && !run.hasRows;
}

/** A snapshot's number-keyed record as the DB's string-keyed one. */
function stringKeyed(rec: Record<number, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(rec));
}

/** dropsBySource as the DB's string-keyed shape; `{}` when the snapshot has none. */
function dropsBySourceOf(tracker: TrackerSnapshot): DbSession['dropsBySource'] {
  const out: DbSession['dropsBySource'] = {};
  for (const [source, bucket] of Object.entries(tracker.dropsBySource ?? {})) {
    out[source as Source] = stringKeyed(bucket);
  }
  return out;
}

/** Every item id a snapshot dropped or spent. */
function idsOf(tracker: TrackerSnapshot): string[] {
  return [...Object.keys(tracker.drops), ...Object.keys(tracker.spent ?? {})];
}

/**
 * Writes one tracked run to the store as it happens, so a crash loses at most
 * the unit in flight. Constructed per run (TrackingService, replay) with the
 * identity the service generated, and fed every engine event:
 *
 *   session tracker_started  -> fresh: insert the live row (endedAt NULL) from
 *                               the opening snapshot; continued: reopen it.
 *   unit_finished            -> ONE transaction: the unit's rows, the session
 *                               totals from its checkpoint, the merged prices.
 *   session tracker_finished -> Stop: delete an empty run, else write the
 *                               final totals and close the row at the event time.
 *
 * Anything else is a no-op, so callers pipe every event through unfiltered.
 * A write that throws leaves the store as it was (one transaction each) and
 * the map-index counter unchanged; the unit that failed is lost, not retried.
 */
export class SessionPersistence {
  private readonly _meta: SessionMeta;
  private readonly _store: SqliteSessionStore;
  private readonly _readPrices: PriceReader;
  /** mapIndex the next unit's primary takes; advanced only after its commit. */
  private _nextMapIndex: number;

  constructor(meta: SessionMeta, deps: SessionPersistenceDeps) {
    this._meta         = meta;
    this._store        = deps.store;
    this._readPrices   = deps.readPrices;
    this._nextMapIndex = meta.nextMapIndex;
  }

  getSessionId(): string {
    return this._meta.sessionId;
  }

  onEngineEvent(event: EngineEvent): PersistOutcome | null {
    if (event.type === 'tracker_started' && event.tracker.kind === 'session') return this._open(event);
    if (event.type === 'unit_finished') return this._saveUnit(event);
    if (event.type === 'tracker_finished' && event.tracker.kind === 'session') return this._close(event);
    return null;
  }

  // -- private --------------------------------------------------------------

  private _open(event: Extract<EngineEvent, {type: 'tracker_started'}>): PersistOutcome {
    const {sessionMeta} = event;
    const id = this._meta.sessionId;
    // A session start meant for another run reaching this one means the
    // caller swapped persistence too late (Reset ordering).
    if (!sessionMeta || sessionMeta.sessionId !== id) {
      throw new Error(`Session start for ${sessionMeta?.sessionId ?? '<none>'} reached the persistence of ${id}`);
    }

    if (this._meta.continued) {
      // The stored totals are what the engine was seeded with: only the end changes.
      if (!this._store.reopenSession(id)) throw new Error(`Cannot reopen session ${id}: not found`);
      log.info('session', `Session reopened: id=${id}`);
      return {savedId: id};
    }

    // Opening snapshot: empty, or a Reset inside a map (map #1, its entry cost carried).
    const record = this._record(event.tracker, sessionMeta);
    this._store.insertSession({...record, priceSnapshot: this._capturePrices(idsOf(event.tracker))});
    log.info('session', `Session inserted: id=${id}`);
    return {savedId: id};
  }

  private _saveUnit(event: Extract<EngineEvent, {type: 'unit_finished'}>): PersistOutcome {
    const {tracker, overlaps, timestamp, checkpoint} = event;
    const mapIndex = this._nextMapIndex;
    // The primary (a map, or a standalone seasonal) takes the next index; every
    // overlap shares it and points at it — under drop-through its drops also
    // live in the primary row, so it is a per-seasonal breakdown of it.
    const rows = [
      this._buildRow(tracker, timestamp, mapIndex, null),
      ...overlaps.map(o => this._buildRow(o.tracker, o.timestamp, mapIndex, mapIndex)),
    ];
    const prices = this._capturePrices([
      ...idsOf(tracker), ...overlaps.flatMap(o => idsOf(o.tracker)), ...idsOf(checkpoint.session),
    ]);

    this._store.transaction(() => {
      this._updateTotals(checkpoint.session, checkpoint);
      this._store.insertRows(rows);
      this._store.mergePriceSnapshot(this._meta.sessionId, prices);
    });
    this._nextMapIndex = mapIndex + 1;
    log.debug('database', `Saved unit #${mapIndex} (${rows.length} rows) for session ${this._meta.sessionId}`);
    return {savedId: this._meta.sessionId};
  }

  private _close(event: Extract<EngineEvent, {type: 'tracker_finished'}>): PersistOutcome | null {
    const {tracker, sessionMeta, timestamp} = event;
    if (!sessionMeta) return null;
    const id = this._meta.sessionId;

    if (isEmptyRun({
      elapsedMs: tracker.elapsed,
      drops:     tracker.drops,
      spent:     tracker.spent ?? {},
      hasRows:   this._store.hasRows(id),
    })) {
      this._store.deleteSession(id);
      log.info('session', `Session discarded (empty): id=${id}`);
      return {deletedId: id};
    }

    const prices = this._capturePrices(idsOf(tracker));
    this._store.transaction(() => {
      this._updateTotals(tracker, sessionMeta);
      this._store.mergePriceSnapshot(id, prices);
      this._store.closeSession(id, timestamp);
    });
    log.info('session', `Session saved: id=${id}`);
    return {savedId: id};
  }

  /** Overwrite the stored totals; throws when the session row is gone (a
   *  deleted session must never collect rows again). */
  private _updateTotals(session: TrackerSnapshot, meta: Pick<UnitCheckpoint, 'mapTime' | 'mapCount'>): void {
    if (!this._store.updateSessionTotals(this._record(session, meta))) {
      throw new Error(`Session ${this._meta.sessionId} no longer exists`);
    }
  }

  /** The session row for a snapshot (ms → s). `name`, `priceSnapshot` and
   *  `endedAt` matter only to the insert: the update never writes them. */
  private _record(session: TrackerSnapshot, meta: Pick<UnitCheckpoint, 'mapTime' | 'mapCount'>): DbSession {
    return {
      id:            this._meta.sessionId,
      name:          this._meta.name,
      savedAt:       new Date().toISOString(),
      totalTime:     session.elapsed / 1000,
      mapTime:       meta.mapTime / 1000,
      mapCount:      meta.mapCount,
      drops:         stringKeyed(session.drops),
      dropsBySource: dropsBySourceOf(session),
      attribution:   'drop-through',
      priceSnapshot: {},
      spent:         stringKeyed(session.spent ?? {}),
      endedAt:       null,
    };
  }

  /** One row from a finished snapshot and its own finish time. `startedAt` is
   *  the tracker's real start (its creation time), `duration` its pause-aware
   *  elapsed — so for a run that froze or went dormant `startedAt + duration`
   *  falls before `endedAt`. `seasonalType` and `phase` come from the snapshot
   *  (null for a map); only a map has an entry cost, so a seasonal's `spent` is {}. */
  private _buildRow(
    tracker: TrackerSnapshot,
    endedAt: number,
    mapIndex: number,
    parentMapIndex: number | null,
  ): DbSessionMap {
    return {
      sessionId:    this._meta.sessionId,
      mapIndex,
      startedAt:    tracker.startedAt,
      endedAt,
      duration:     tracker.elapsed,
      drops:        stringKeyed(tracker.drops),
      spent:        stringKeyed(tracker.spent ?? {}),
      seasonalType: tracker.seasonalType ?? null,
      parentMapIndex,
      phase:        tracker.phase ?? null,
    };
  }

  /**
   * Current prices of `ids`, to merge into the session's snapshot (first price
   * wins, so each item keeps the price of its first appearance). Consumed
   * materials live in `spent` and are often disjoint from `drops`. Only
   * positive prices: a zero is indistinguishable from absent to a reader, and
   * both degrade to the live price.
   */
  private _capturePrices(ids: string[]): Record<string, number> {
    const needed = new Set(ids);
    if (needed.size === 0) return {};
    // fromEntries, not assignment: ids like "__proto__" stay plain keys.
    return Object.fromEntries(
      Object.entries(this._readPrices(needed)).filter(([id, price]) => needed.has(id) && price > 0),
    );
  }
}
