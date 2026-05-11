import {Tracker} from './tracker';
import {SeasonalTracker} from './seasonal-tracker';
import type {SeasonalType, Source} from './tracker';
import type {EmitFn} from './types';
import type {ItemFilterEngine} from './item-filter';
import type {FilterScope} from '@/types/itemFilter';
import {log} from '@/main/logger';

export interface DistributeResult {
  sessionAccepted:  boolean;
  mapChanged:       boolean;
  seasonalsChanged: Set<SeasonalType>;
}

/**
 * TrackerRegistry — owns the collection of trackers, the writer rule, fan-out
 * to active scopes, and bubble exclusivity. Knows nothing about log events.
 */
export class TrackerRegistry {
  session: Tracker | null = null;
  map:     Tracker | null = null;

  private _seasonals:  Map<SeasonalType, SeasonalTracker> = new Map();
  private _startOrder: SeasonalType[]                     = [];
  // Writer cache. `undefined` = needs recompute, `null` = no writer.
  private _currentWriter: Source | null | undefined = undefined;

  // -----------------------------------------------------------------------
  // Lookup
  // -----------------------------------------------------------------------

  seasonal(type: SeasonalType): SeasonalTracker | null {
    return this._seasonals.get(type) ?? null;
  }

  seasonals(): IterableIterator<SeasonalTracker> {
    return this._seasonals.values();
  }

  seasonalsSize(): number {
    return this._seasonals.size;
  }

  hasBubble(): boolean {
    for (const t of this._seasonals.values()) if (t.ownsBubble) return true;
    return false;
  }

  // -----------------------------------------------------------------------
  // Lifecycle starters
  // -----------------------------------------------------------------------

  startSession(): Tracker {
    this.session = new Tracker('session');
    this._currentWriter = undefined;
    return this.session;
  }

  startMap(): Tracker | null {
    if (this.hasBubble()) return null;
    this.map = new Tracker('map');
    this._currentWriter = undefined;
    return this.map;
  }

  /**
   * Start a seasonal tracker. Idempotent for the same type. Bubble rule:
   *   - Starting a bubble seasonal evicts every active non-bubble seasonal.
   *   - Starting a non-bubble while a bubble is up is a silent no-op.
   */
  startSeasonal(opts: {
    type:               SeasonalType;
    ownsBubble?:        boolean;
    lootDurationMs?:    number;
    pauseOnLootExpiry?: boolean;
  }, emit: EmitFn): SeasonalTracker | null {
    const type       = opts.type;
    const ownsBubble = opts.ownsBubble ?? false;

    const existing = this._seasonals.get(type);
    if (existing) return existing;

    if (ownsBubble) {
      for (const otherType of [...this._startOrder]) {
        this._seasonals.get(otherType)?.finish();
      }
    } else if (this.hasBubble()) {
      log.debug('engine', `${type} start ignored: bubble seasonal active`);
      return null;
    }

    const tracker = new SeasonalTracker({
      registry:          this,
      emit,
      type,
      ownsBubble,
      lootDurationMs:    opts.lootDurationMs,
      pauseOnLootExpiry: opts.pauseOnLootExpiry,
    });
    this._seasonals.set(type, tracker);
    this._startOrder.push(type);
    this._currentWriter = undefined;
    emit({type: 'tracker_started', tracker: tracker.snapshot(), timestamp: Date.now()});
    return tracker;
  }

  // -----------------------------------------------------------------------
  // Tracker callbacks
  // -----------------------------------------------------------------------

  /** Internal: SeasonalTracker.finish() calls this once it has cancelled its
   *  timer. The tracker passes the snapshot it took before signalling so the
   *  registry can emit tracker_finished with the correct state. */
  _onSeasonalFinished(tracker: SeasonalTracker, emit: EmitFn): void {
    const type = tracker.seasonalType;
    if (!this._seasonals.has(type)) return;
    const snap = tracker.snapshot();
    this._seasonals.delete(type);
    const idx = this._startOrder.indexOf(type);
    if (idx >= 0) this._startOrder.splice(idx, 1);
    this._currentWriter = undefined;
    emit({type: 'tracker_finished', tracker: snap, timestamp: Date.now()});
  }

  _onSeasonalStateChanged(tracker: SeasonalTracker, emit: EmitFn): void {
    this._currentWriter = undefined;
    emit({type: 'tracker_update', tracker: tracker.snapshot(), timestamp: Date.now()});
  }

  // -----------------------------------------------------------------------
  // Fan-out
  // -----------------------------------------------------------------------

  isLootContext(): boolean {
    return this.map !== null || this._seasonals.size > 0;
  }

  writer(): Source | null {
    if (this._currentWriter !== undefined) return this._currentWriter;
    let writer: Source | null = null;
    for (let i = this._startOrder.length - 1; i >= 0; i--) {
      const t = this._seasonals.get(this._startOrder[i]);
      if (t && t.active) { writer = this._startOrder[i]; break; }
    }
    if (writer === null && this.map !== null) writer = 'map';
    this._currentWriter = writer;
    return writer;
  }

  invalidateWriter(): void {
    this._currentWriter = undefined;
  }

  distributeDrop(itemId: number, change: number, filter: ItemFilterEngine | null): DistributeResult {
    const result: DistributeResult = {
      sessionAccepted:  false,
      mapChanged:       false,
      seasonalsChanged: new Set(),
    };

    const sessionIncluded = !filter || filter.shouldInclude(itemId, 'session' as FilterScope);
    if (sessionIncluded && this.session) {
      this.session.addDrop(itemId, change);
      result.sessionAccepted = true;
    }
    if (this.map && (!filter || filter.shouldInclude(itemId, 'map' as FilterScope))) {
      this.map.addDrop(itemId, change);
      result.mapChanged = true;
    }
    for (const [type, tracker] of this._seasonals) {
      if (!tracker.active) continue;
      if (filter && !filter.shouldInclude(itemId, type as FilterScope)) continue;
      tracker.addDrop(itemId, change);
      result.seasonalsChanged.add(type);
    }
    if (sessionIncluded && this.session) {
      const w = this.writer();
      if (w !== null) this.session.addDropToSource(w, itemId, change);
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Mass teardown
  // -----------------------------------------------------------------------

  /** Finish every active seasonal — each emits its own tracker_finished. */
  finishAllSeasonals(): void {
    for (const tracker of [...this._seasonals.values()]) {
      tracker.finish();
    }
  }

  /** Finish all seasonals, then the map tracker. ZoneHandler town path. */
  finishAll(emit: EmitFn): void {
    this.finishAllSeasonals();
    if (this.map) {
      const snap = this.map.snapshot();
      this.map = null;
      this._currentWriter = undefined;
      emit({type: 'tracker_finished', tracker: snap, timestamp: Date.now()});
    }
  }

  /** Drop every tracker silently (no events). Used by Engine.stop()/reset()
   *  where the engine has its own emission policy. Cancels seasonal loot
   *  timers as a side-effect so no callbacks fire after teardown. */
  reset(): void {
    for (const t of this._seasonals.values()) t.cancelLootTimer();
    this.session = null;
    this.map     = null;
    this._seasonals.clear();
    this._startOrder = [];
    this._currentWriter = undefined;
  }
}
