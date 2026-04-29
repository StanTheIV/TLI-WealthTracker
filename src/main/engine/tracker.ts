export type SeasonalType = 'vorex' | 'dream' | 'overrealm' | 'carjack' | 'clockwork' | 'sandlord';
export type TrackerKind = 'session' | 'map' | 'seasonal';

export interface TrackerSnapshot {
  kind:          TrackerKind;
  drops:         Record<number, number>;
  elapsed:       number;
  seasonalType?: SeasonalType;
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
 */
export class Tracker {
  readonly kind:          TrackerKind;
  readonly seasonalType?: SeasonalType;

  private _drops:       Map<number, number> = new Map();
  private _startTime:   number;
  private _accumulated: number = 0;
  private _pausedAt:    number | null = null;

  constructor(kind: TrackerKind, seasonalType?: SeasonalType) {
    this.kind        = kind;
    this.seasonalType = seasonalType;
    this._startTime  = Date.now();
  }

  get active(): boolean {
    return this._pausedAt === null;
  }

  addDrop(itemId: number, change: number): void {
    if (!this.active) return;
    this._drops.set(itemId, (this._drops.get(itemId) ?? 0) + change);
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
    return {
      kind:    this.kind,
      drops,
      elapsed: this.elapsed(),
      ...(this.seasonalType ? {seasonalType: this.seasonalType} : {}),
    };
  }
}
