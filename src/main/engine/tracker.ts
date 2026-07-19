export type SeasonalType = 'vorex' | 'dream' | 'overrealm' | 'carjack' | 'clockwork' | 'sandlord' | 'lunaria' | 'arcana';
/** A drop's attribution source — 'map' or one of the seasonal types. */
export type Source = 'map' | SeasonalType;
export type TrackerKind = 'session' | 'map' | 'seasonal';

export interface TrackerSnapshot {
  kind:          TrackerKind;
  drops:         Record<number, number>;
  elapsed:       number;
  seasonalType?: SeasonalType;
  /** False while the tracker is paused (e.g. Lunaria between strum episodes —
   *  drops won't accrue but the tracker isn't finished). True for normal
   *  active seasonals. */
  active:        boolean;
  /** Per-source breakdown — populated only on the session tracker's snapshot.
   *  Each drop is attributed to exactly one source (newest active tracker at
   *  the moment the drop fired) so summing per-source totals reproduces
   *  session FE. Omitted on map and seasonal snapshots. */
  dropsBySource?: Record<Source, Record<number, number>>;
}

/**
 * Tracker — a self-contained drop accumulator with independent pause/resume.
 *
 * Used for three lifecycle scopes:
 *   session  — created on engine start, destroyed on stop
 *   map      — created on map entry, destroyed on town entry
 *   seasonal — created by seasonal trigger, destroyed by corresponding exit
 *
 * All three instances receive the same drops via EngineContext.distributeDrop().
 *
 * `ownsBubble` is set on seasonals (e.g. Sandlord) whose bubble subsumes regular
 * map zones — ZoneHandler consults it to skip creating a per-map tracker inside.
 */
export class Tracker {
  readonly kind:          TrackerKind;
  readonly seasonalType?: SeasonalType;
  readonly ownsBubble:    boolean;

  private _drops:       Map<number, number> = new Map();
  private _startTime:   number;
  private _accumulated: number = 0;
  private _pausedAt:    number | null = null;
  // Per-source breakdown for the session tracker only. Each drop is attributed
  // to exactly one source via the writer rule in EngineContext. Other
  // trackers (map, seasonal) leave this empty — their `_drops` plays the
  // analogous role for "what fell while this tracker was running."
  private _dropsBySource: Map<Source, Map<number, number>> = new Map();

  constructor(kind: TrackerKind, seasonalType?: SeasonalType, ownsBubble: boolean = false) {
    this.kind         = kind;
    this.seasonalType = seasonalType;
    this.ownsBubble   = ownsBubble;
    this._startTime   = Date.now();
  }

  get active(): boolean {
    return this._pausedAt === null;
  }

  addDrop(itemId: number, change: number): void {
    if (!this.active) return;
    this._drops.set(itemId, (this._drops.get(itemId) ?? 0) + change);
  }

  /**
   * Attribute a drop to a specific source bucket. Only meaningful on the
   * session tracker (other trackers leave _dropsBySource empty). Short-circuits
   * on pause for the same reason addDrop does — protects against an in-flight
   * drop racing with engine.pause() that would otherwise leave _dropsBySource
   * accumulating drops the session's _drops correctly rejected.
   */
  addDropToSource(source: Source, itemId: number, change: number): void {
    if (!this.active) return;
    let bucket = this._dropsBySource.get(source);
    if (!bucket) {
      bucket = new Map();
      this._dropsBySource.set(source, bucket);
    }
    bucket.set(itemId, (bucket.get(itemId) ?? 0) + change);
  }

  /**
   * Add a time offset to the accumulated elapsed — used when continuing a saved session.
   * @param ms Milliseconds to add (e.g. totalTime * 1000 from DB where DB stores seconds).
   */
  addTimeOffset(ms: number): void {
    this._accumulated += ms;
  }

  pause(): void {
    if (this._pausedAt !== null) return;
    this._accumulated += Date.now() - this._startTime;
    this._pausedAt = Date.now();
  }

  resume(): void {
    if (this._pausedAt === null) return;
    this._startTime = Date.now();
    this._pausedAt  = null;
  }

  elapsed(): number {
    if (this._pausedAt !== null) return this._accumulated;
    return this._accumulated + (Date.now() - this._startTime);
  }

  snapshot(): TrackerSnapshot {
    const drops: Record<number, number> = {};
    for (const [k, v] of this._drops) drops[k] = v;
    const snap: TrackerSnapshot = {
      kind:    this.kind,
      drops,
      elapsed: this.elapsed(),
      active:  this.active,
      ...(this.seasonalType ? {seasonalType: this.seasonalType} : {}),
    };
    if (this._dropsBySource.size > 0) {
      const dbs: Record<Source, Record<number, number>> = {} as Record<Source, Record<number, number>>;
      for (const [source, bucket] of this._dropsBySource) {
        const entry: Record<number, number> = {};
        for (const [id, qty] of bucket) entry[id] = qty;
        dbs[source] = entry;
      }
      snap.dropsBySource = dbs;
    }
    return snap;
  }
}
