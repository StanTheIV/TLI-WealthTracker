/**
 * Replays engine events into a per-type "last published flags" map and checks
 * the owner-publishing invariant (step 1.5):
 *
 * - every seasonal tracker_started/tracker_update carries a boolean `owner`;
 *   map/session snapshots never carry the key;
 * - when the engine is reachable (`writer`), the stamp equals `writer() === type`
 *   at emit time;
 * - a seasonal tracker_update is emitted only for a real change: different
 *   drops, or a different published `{active, owner}` pair;
 * - ownership is a SET property: at a settled point at most one live seasonal's
 *   last-published owner is true;
 * - with `live`, settled points are exact: every live seasonal's published pair
 *   equals its true `{active, owner = writer()===type}`, none other is published;
 * - the renderer store (engineStore.handleEvent) shows the same owner per type.
 */
import type {EngineEvent, SeasonalType, Source} from '@/shared/contracts/engine';
import {useEngineStore} from '@/state/engineStore';

interface Published {active: boolean; owner: boolean; drops: string}

export interface LiveState {
  writer:    Source | null;
  seasonals: Array<{type: SeasonalType; active: boolean}>;
}

export class OwnerWatcher {
  readonly violations: string[] = [];
  readonly published = new Map<SeasonalType, Published>();
  private _n = 0;

  constructor(private readonly _opts: {writer?: () => Source | null; store?: boolean} = {}) {
    if (_opts.store) useEngineStore.getState().reset();
  }

  private _bad(msg: string): void {
    this.violations.push(`#${this._n} ${msg}`);
  }

  onEmit(ev: EngineEvent): void {
    this._n++;
    if (ev.type === 'tracker_started' || ev.type === 'tracker_update') {
      const t = ev.tracker;
      if (t.kind !== 'seasonal' || !t.seasonalType) {
        if ('owner' in t) this._bad(`${ev.type} ${t.kind} carries owner`);
      } else {
        const type  = t.seasonalType;
        const owner = t.owner;
        if (typeof owner !== 'boolean') this._bad(`${ev.type} ${type} owner not boolean (${String(owner)})`);
        if (this._opts.writer) {
          const truth = this._opts.writer() === type;
          if (owner !== truth) this._bad(`${ev.type} ${type} stamped owner=${String(owner)} but writer()===type is ${truth}`);
        }
        const drops = JSON.stringify(t.drops);
        const prev  = this.published.get(type);
        if (ev.type === 'tracker_update') {
          if (!prev) this._bad(`tracker_update ${type} with nothing published`);
          else if (prev.active === t.active && prev.owner === (owner === true) && prev.drops === drops) {
            this._bad(`redundant tracker_update ${type} {active:${t.active}, owner:${String(owner)}} unchanged`);
          }
        } else if (prev) {
          this._bad(`tracker_started ${type} while already published`);
        }
        this.published.set(type, {active: t.active, owner: owner === true, drops});
      }
    } else if (ev.type === 'tracker_finished' && ev.tracker.seasonalType) {
      this.published.delete(ev.tracker.seasonalType);
    } else if ((ev.type === 'tracker_finished' && ev.tracker.kind === 'session') || ev.type === 'engine_stopped') {
      // The run is over: a stop drops the live seasonals without finishing
      // them, and their rows go with it.
      this.published.clear();
    }
    if (this._opts.store) {
      if (ev.type !== 'unit_finished') useEngineStore.getState().handleEvent(ev); // never on the wire
      this._storeParity();
    }
  }

  /** The renderer's per-type owner equals the published one, per event. */
  private _storeParity(): void {
    const store = useEngineStore.getState().seasonalTrackers;
    for (const type of new Set([...store.keys(), ...this.published.keys()])) {
      const s = store.get(type);
      const p = this.published.get(type);
      if (!s !== !p) this._bad(`store/published presence differs for ${type}`);
      else if (s && p && (s.owner === true) !== p.owner) this._bad(`store owner ${type}=${String(s.owner)} vs published ${p.owner}`);
    }
  }

  /** The published owners, at most one true. A settled-point check. */
  checkSet(label: string): void {
    const owners = [...this.published].filter(([, p]) => p.owner).map(([t]) => t);
    if (owners.length > 1) this._bad(`${label}: several published owners ${owners.join(',')}`);
  }

  /** Exact settled-point check against the engine's truth. */
  checkLive(label: string, live: LiveState): void {
    this.checkSet(label);
    const types = new Set(live.seasonals.map(s => s.type));
    for (const t of this.published.keys()) if (!types.has(t)) this._bad(`${label}: ${t} published but not live`);
    for (const {type, active} of live.seasonals) {
      const p = this.published.get(type);
      if (!p) { this._bad(`${label}: ${type} live but never published`); continue; }
      if (p.active !== active) this._bad(`${label}: ${type} published active=${p.active}, true ${active}`);
      const truth = live.writer === type;
      if (p.owner !== truth) this._bad(`${label}: ${type} published owner=${p.owner}, writer()=${String(live.writer)}`);
    }
    if (this._opts.store) {
      const store = useEngineStore.getState().seasonalTrackers;
      for (const {type} of live.seasonals) {
        if ((store.get(type)?.owner === true) !== (live.writer === type)) this._bad(`${label}: store ring ${type} wrong`);
      }
      if (store.size !== live.seasonals.length) this._bad(`${label}: store holds ${store.size} seasonals, ${live.seasonals.length} live`);
    }
  }
}

/** Settled points inside an event list: after the last event of each run of
 *  seasonal tracker_* events (a hand-off publishes both sides back to back). */
export function settledIndexes(events: EngineEvent[]): Set<number> {
  const isSeasonal = (e: EngineEvent | undefined) =>
    !!e && (e.type === 'tracker_started' || e.type === 'tracker_update' || e.type === 'tracker_finished')
    && !!e.tracker.seasonalType;
  const out = new Set<number>();
  events.forEach((e, i) => { if (!isSeasonal(events[i + 1]) || !isSeasonal(e)) out.add(i); });
  return out;
}
