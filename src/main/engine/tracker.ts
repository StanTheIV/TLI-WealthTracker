import type {SeasonalType, Source, TrackerKind, TrackerSnapshot} from '@/shared/contracts/engine';

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
  /** Map trackers: the run's map ordinal, stamped by TrackerRegistry.startMap
   *  (from 1). Internal identity for parenting seasonals — never persisted,
   *  never on a snapshot. 0 on session/seasonal trackers. */
  seq: number = 0;

  private _drops:      Map<number, number> = new Map();
  private _startTime:   number;
  private _accumulated: number = 0;
  private _pausedAt:    number | null = null;
  // Per-source breakdown for the session tracker only. Each drop is attributed
  // to exactly one source via the writer rule in EngineContext. Other
  // trackers (map, seasonal) leave this empty — their `_drops` plays the
  // analogous role for "what fell while this tracker was running."
  private _dropsBySource: Map<Source, Map<number, number>> = new Map();
  // Entry cost (positive magnitudes): the map's own, or the session's running
  // total. Kept apart from _drops — a consumed material is not negative loot.
  private _spent: Map<number, number> = new Map();

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

  /** Add to the entry cost. No `active` guard: cost is structural (crediting
   *  while paused is already prevented upstream — a paused entry has no buffer). */
  addCost(itemId: number, qty: number): void {
    if (qty === 0) return;
    this._spent.set(itemId, (this._spent.get(itemId) ?? 0) + qty);
  }

  /** Replace the entry cost with a copy of `cost`. */
  setEntryCost(cost: ReadonlyMap<number, number>): void {
    this._spent = new Map(cost);
  }

  get entryCost(): ReadonlyMap<number, number> {
    return this._spent;
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
    if (this._spent.size > 0) {
      const spent: Record<number, number> = {};
      for (const [id, qty] of this._spent) spent[id] = qty;
      snap.spent = spent;
    }
    return snap;
  }
}
