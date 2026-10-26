import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {EngineEvent, Source, TrackerSnapshot} from '@/shared/contracts/engine';
import type {SqliteSessionStore} from './db/session-store';
import {log} from './logger';

/** Identity of the session currently being tracked. */
export interface SessionMeta {
  /** UUID — either freshly generated or the id of a continued session. */
  sessionId:   string;
  /** Name of a continued session. Null for new sessions (auto-generated on save). */
  sessionName: string | null;
  /** True when this run is overwriting a previously-saved session. */
  isOverride:  boolean;
}

/** Outcome of consuming the session-finish event. */
export interface AutoSaveOutcome {
  /** Saved session id, or null when the run was discarded (too short, no drops). */
  savedId: string | null;
}

/** Current price of each requested item id the reader knows. */
export type PriceReader = (ids: ReadonlySet<string>) => Record<string, number>;

export interface SessionPersistenceDeps {
  store:      SqliteSessionStore;
  readPrices: PriceReader;
}

/** Minimum total session duration (ms) before auto-saving an empty run. */
const MIN_SAVE_DURATION_MS = 30_000;

/** A snapshot's number-keyed record as the DB's string-keyed one. */
function stringKeyed(rec: Record<number, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(rec));
}

function generateSessionName(): string {
  const now   = new Date();
  const month = now.toLocaleString('en', {month: 'short'});
  const day   = now.getDate();
  const year  = now.getFullYear();
  const time  = now.toLocaleTimeString('en', {hour: '2-digit', minute: '2-digit', hour12: false});
  return `Session - ${month} ${day}, ${year} ${time}`;
}

/**
 * Owns the per-session persistence buffer and the session identity for one
 * tracked run. Constructed by TrackingService per run, fed every engine event
 * via onEngineEvent, and either commits (autoSave on session-finish) or is
 * thrown away (engine reset / stop / app quit).
 *
 * The engine decides what a saved unit is (`unit_finished`: a map with its
 * child seasonal runs, or a standalone run); this class only numbers the
 * units and turns them into rows.
 *
 * Buffering is deliberate: a discarded short run shouldn't leak per-map rows
 * into the DB. The class enforces that — once instances are gone, so are
 * their pending rows.
 */
export class SessionPersistence {
  private readonly _meta: SessionMeta;
  private readonly _store: SqliteSessionStore;
  private readonly _readPrices: PriceReader;
  private _pendingRows: DbSessionMap[] = [];
  /** mapIndex of the most recently buffered unit; 0 before the first. */
  private _lastPrimaryMapIndex: number = 0;

  constructor(meta: SessionMeta, deps: SessionPersistenceDeps) {
    this._meta       = meta;
    this._store      = deps.store;
    this._readPrices = deps.readPrices;
  }

  getSessionId(): string {
    return this._meta.sessionId;
  }

  /**
   * Consume an engine event:
   *   unit_finished             -> buffer `[primary, ...overlaps]`. The primary
   *                                (a map, or a standalone seasonal) takes the
   *                                next mapIndex; every overlap shares it and
   *                                points at it — under drop-through its drops
   *                                also live in the parent map row, so it is a
   *                                per-seasonal breakdown of it.
   *   session tracker_finished  -> commit (autoSave) and return whether
   *                                anything was saved.
   * Anything else (a map's or seasonal's own tracker_finished included) is a
   * no-op; callers can pipe every engine event through without filtering.
   */
  onEngineEvent(event: EngineEvent): AutoSaveOutcome | null {
    if (event.type === 'unit_finished') {
      const {tracker, overlaps, timestamp} = event;
      const mapIndex = ++this._lastPrimaryMapIndex;
      this._pendingRows.push(this._buildRow(tracker, timestamp, mapIndex, null));
      for (const o of overlaps) {
        this._pendingRows.push(this._buildRow(o.tracker, o.timestamp, mapIndex, mapIndex));
      }
      return null;
    }

    if (event.type === 'tracker_finished' && event.tracker.kind === 'session') {
      const savedId = this._autoSave(event);
      // Whatever path autoSave took (saved or skipped), the buffer is gone.
      this._pendingRows = [];
      this._lastPrimaryMapIndex = 0;
      return {savedId};
    }

    return null;
  }

  /**
   * Drop any buffered per-run rows. Call when the engine is being reset or
   * stopped without a natural session-finish flow (e.g. user clicked Reset).
   */
  discard(): void {
    this._pendingRows = [];
    this._lastPrimaryMapIndex = 0;
  }

  // -- private --------------------------------------------------------------

  /** One row from a snapshot finished at `timestamp`. `seasonalType` and
   *  `phase` come from the snapshot (null for a map); only a map has an entry
   *  cost, so a seasonal's `spent` is {}. */
  private _buildRow(
    tracker: TrackerSnapshot,
    timestamp: number,
    mapIndex: number,
    parentMapIndex: number | null,
  ): DbSessionMap {
    return {
      sessionId:    this._meta.sessionId,
      mapIndex,
      startedAt:    timestamp - tracker.elapsed,
      duration:     tracker.elapsed,
      drops:        stringKeyed(tracker.drops),
      spent:        stringKeyed(tracker.spent ?? {}),
      seasonalType: tracker.seasonalType ?? null,
      parentMapIndex,
      phase:        tracker.phase ?? null,
    };
  }

  /**
   * Freeze current prices for every item this session touched. Consumed
   * materials live in `spent` (session and rows) and are often disjoint from
   * `drops`. Zero-priced items are skipped — indistinguishable from absent to
   * a reader, and both degrade to the live price.
   */
  private _capturePrices(drops: Record<string, number>, spent: Record<string, number>): Record<string, number> {
    const needed = new Set([...Object.keys(drops), ...Object.keys(spent)]);
    for (const row of this._pendingRows) {
      for (const id of Object.keys(row.spent)) needed.add(id);
    }
    if (needed.size === 0) return {};

    const out: Record<string, number> = {};
    for (const [id, price] of Object.entries(this._readPrices(needed))) {
      if (needed.has(id) && price > 0) out[id] = price;
    }
    return out;
  }

  /**
   * Persist the just-finished session and any buffered per-run rows.
   * Returns the saved id, or null if the run was below MIN_SAVE_DURATION_MS
   * with no drops (a discarded short run).
   */
  private _autoSave(event: Extract<EngineEvent, {type: 'tracker_finished'}>): string | null {
    const {tracker, sessionMeta} = event;
    if (!sessionMeta) return null;

    const totalTimeMs = tracker.elapsed;
    const drops = stringKeyed(tracker.drops);
    const spent = stringKeyed(tracker.spent ?? {});
    // A consumed map material is content too (it used to arrive as a negative drop).
    const hasContent = Object.keys(drops).length > 0 || Object.keys(spent).length > 0;
    const hasTime    = totalTimeMs >= MIN_SAVE_DURATION_MS;
    if (!hasContent && !hasTime) return null;

    // Project tracker.dropsBySource (Record<Source, Record<number, number>>)
    // to JSON-friendly string-keyed shape. Mirror the same number→string
    // boundary handling we use for `drops` on this same line.
    const dropsBySource: DbSession['dropsBySource'] = {};
    if (tracker.dropsBySource) {
      for (const [source, bucket] of Object.entries(tracker.dropsBySource)) {
        const entry: Record<string, number> = {};
        for (const [id, qty] of Object.entries(bucket)) entry[String(id)] = qty;
        dropsBySource[source as Source] = entry;
      }
    }

    const record: DbSession = {
      id:        this._meta.sessionId,
      name:      this._meta.sessionName ?? generateSessionName(),
      savedAt:   new Date().toISOString(),
      totalTime: totalTimeMs / 1000,
      mapTime:   sessionMeta.mapTime / 1000,
      mapCount:  sessionMeta.mapCount,
      drops,
      dropsBySource,
      attribution: 'drop-through',
      priceSnapshot: this._capturePrices(drops, spent),
      spent,
    };

    // The session row and its per-map rows commit together or not at all.
    this._store.transaction(() => {
      if (this._meta.isOverride) this._store.updateSessionTotals(record);
      else                       this._store.insertSession(record);
      this._store.insertRows(this._pendingRows);
    });
    if (this._pendingRows.length > 0) {
      log.debug('database', `Saved ${this._pendingRows.length} per-map rows for session ${record.id}`);
    }

    log.info('session', `Session saved: id=${record.id}`);
    return record.id;
  }
}
