import {sessionsInsert, sessionsUpdate, sessionMapsInsert, itemsGetAll} from './db';
import type {DbSession, DbSessionMap} from './db';
import type {EngineEvent} from '@/types/electron';
import type {Engine} from './engine/engine';
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

/** Minimum total session duration (ms) before auto-saving an empty run. */
const MIN_SAVE_DURATION_MS = 30_000;

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
 * tracked run. Constructed in startEngine, fed engine events via
 * onTrackerFinished, and either commits (autoSave on session-finish) or is
 * thrown away (engine reset / stop / app quit).
 *
 * Buffering is deliberate: a discarded short run shouldn't leak per-map rows
 * into the DB. The class enforces that — once instances are gone, so are
 * their pending rows.
 */
export class SessionPersistence {
  private readonly _meta: SessionMeta;
  private _pendingRows: DbSessionMap[] = [];
  /** mapIndex of the most-recently-buffered primary row (regular map or
   *  standalone seasonal). Overlap seasonal rows attach to this. 0 before any
   *  primary row exists — overlap rows in that window have no parent and are
   *  treated as standalones (defensive; should never happen in practice). */
  private _lastPrimaryMapIndex: number = 0;

  constructor(meta: SessionMeta) {
    this._meta = meta;
  }

  getSessionId(): string {
    return this._meta.sessionId;
  }

  /**
   * Consume a `tracker_finished` event from the engine. Routes by tracker kind:
   *   map      -> buffer a primary map row (seasonalType=null), bumps map index.
   *   seasonal -> standalone (no active map): primary row, bumps map index.
   *               overlap (active map):       buffer with parentMapIndex set —
   *                                           under drop-through those drops
   *                                           also live in the parent map row,
   *                                           so the overlap row is a per-
   *                                           seasonal breakdown of it.
   *   session  -> commit (autoSave) and return whether anything was saved.
   *
   * For non-`tracker_finished` events this is a no-op; callers can pipe every
   * engine event through without filtering.
   */
  onTrackerFinished(event: EngineEvent, engine: Engine): AutoSaveOutcome | null {
    if (event.type !== 'tracker_finished') return null;

    const {tracker, timestamp} = event;

    if (tracker.kind === 'map') {
      const mapIndex = ++this._lastPrimaryMapIndex;
      this._pendingRows.push(this._buildRow(tracker, timestamp, engine.getLastMapSpends(), null, mapIndex, null));
      return null;
    }

    if (tracker.kind === 'seasonal') {
      if (engine.hasActiveMapTracker() && this._lastPrimaryMapIndex > 0) {
        // Overlap row — a breakdown of the parent map row, which already
        // includes these drops (drop-through attribution).
        this._pendingRows.push(this._buildRow(tracker, timestamp, {}, tracker.seasonalType ?? null, this._lastPrimaryMapIndex, this._lastPrimaryMapIndex));
      } else {
        // Standalone seasonal (Sandlord, etc.) — primary row. It owns its entry
        // cost: ItemHandler records the pre-map flush on any transition into a
        // loot context, and a town -> hub entry is one, so no map row exists to
        // carry the spend.
        const mapIndex = ++this._lastPrimaryMapIndex;
        this._pendingRows.push(this._buildRow(tracker, timestamp, engine.getLastMapSpends(), tracker.seasonalType ?? null, mapIndex, null));
      }
      return null;
    }

    if (tracker.kind === 'session') {
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

  private _buildRow(
    tracker: Extract<EngineEvent, {type: 'tracker_finished'}>['tracker'],
    timestamp: number,
    spent: Record<string, number>,
    seasonalType: DbSessionMap['seasonalType'],
    mapIndex: number,
    parentMapIndex: number | null,
  ): DbSessionMap {
    const drops: Record<string, number> = {};
    for (const [k, v] of Object.entries(tracker.drops)) drops[String(k)] = v;
    return {
      sessionId:    this._meta.sessionId,
      mapIndex,
      startedAt:    timestamp - tracker.elapsed,
      duration:     tracker.elapsed,
      drops,
      spent,
      seasonalType,
      parentMapIndex,
    };
  }

  /**
   * Freeze current prices for every item this session touched. Consumed
   * materials live in the rows' `spent` and are often disjoint from `drops`.
   * Zero-priced items are skipped — indistinguishable from absent to a reader,
   * and both degrade to the live price.
   */
  private _capturePrices(drops: Record<string, number>): Record<string, number> {
    const needed = new Set(Object.keys(drops));
    for (const row of this._pendingRows) {
      for (const id of Object.keys(row.spent)) needed.add(id);
    }
    if (needed.size === 0) return {};

    const out: Record<string, number> = {};
    for (const item of itemsGetAll()) {
      if (needed.has(item.id) && item.price > 0) out[item.id] = item.price;
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
    const hasDrops = Object.keys(tracker.drops).length > 0;
    const hasTime  = totalTimeMs >= MIN_SAVE_DURATION_MS;
    if (!hasDrops && !hasTime) return null;

    const drops: Record<string, number> = {};
    for (const [k, v] of Object.entries(tracker.drops)) drops[String(k)] = v;

    // Project tracker.dropsBySource (Record<Source, Record<number, number>>)
    // to JSON-friendly string-keyed shape. Mirror the same number→string
    // boundary handling we use for `drops` on this same line.
    const dropsBySource: Record<string, Record<string, number>> = {};
    if (tracker.dropsBySource) {
      for (const [source, bucket] of Object.entries(tracker.dropsBySource)) {
        const entry: Record<string, number> = {};
        for (const [id, qty] of Object.entries(bucket)) entry[String(id)] = qty;
        dropsBySource[source] = entry;
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
      priceSnapshot: this._capturePrices(drops),
    };

    if (this._meta.isOverride) sessionsUpdate(record);
    else                       sessionsInsert(record);

    if (this._pendingRows.length > 0) {
      sessionMapsInsert(this._pendingRows);
      log.debug('database', `Saved ${this._pendingRows.length} per-map rows for session ${record.id}`);
    }

    log.info('session', `Session saved: id=${record.id}`);
    return record.id;
  }
}
