/**
 * Checks the saved-unit invariants (step 1.6) over an engine event stream.
 *
 * - every seasonal `tracker_finished` is in exactly ONE unit: an overlap of a map
 *   unit or a standalone unit, with the same snapshot and its own finish time;
 *   exceptions: runs discarded by `Engine.reset` (no units) and trackers still
 *   live at stop (they never finish);
 * - every map `tracker_finished` is followed IMMEDIATELY by exactly one map
 *   `unit_finished` carrying the same snapshot and the same timestamp; a map
 *   unit follows nothing else;
 * - overlaps are finished BEFORE their map, in finish order, each timestamp is the
 *   child's own finish and is <= the unit's;
 * - a standalone unit follows its own `tracker_finished`, carries no overlaps
 *   and its finish timestamp;
 * - nothing is emitted as a unit after the session `tracker_finished` (until the
 *   next session `tracker_started`), and nothing is left unclaimed at that point.
 */
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';

export interface UnitCheckOptions {
  /** Indexes in `events` where `Engine.reset()` was called. The events from
   *  there up to the next session `tracker_started` belong to the reset. */
  resets?: number[];
}

interface Finished {idx: number; snap: TrackerSnapshot; ts: number; claimed: number}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function checkUnits(events: ReadonlyArray<EngineEvent>, opts: UnitCheckOptions = {}): string[] {
  const bad: string[] = [];
  const resets = new Set(opts.resets ?? []);
  let inReset = false;
  let sessionOver = false;
  let finished: Finished[] = [];            // seasonal finishes not yet claimed by a unit
  let lastMap: {idx: number; snap: TrackerSnapshot; ts: number; units: number} | null = null;

  const closeMap = (at: number) => {
    if (lastMap && lastMap.units !== 1) bad.push(`#${at}: map finished at #${lastMap.idx} got ${lastMap.units} unit(s)`);
    lastMap = null;
  };

  const claim = (snap: TrackerSnapshot, ts: number, where: string, before: number): Finished | null => {
    const hit = finished.find(f => f.claimed === 0 && f.ts === ts && same(f.snap, snap) && f.idx < before);
    if (!hit) {
      bad.push(`${where}: ${snap.seasonalType} @${ts} matches no unclaimed seasonal tracker_finished`);
      return null;
    }
    hit.claimed++;
    return hit;
  };

  events.forEach((ev, i) => {
    if (resets.has(i)) {
      // A reset run saves nothing: pending finished children are discarded.
      if (lastMap) closeMap(i);
      finished = [];
      inReset = true;
    }

    if (ev.type === 'tracker_started' && ev.tracker.kind === 'session') {
      inReset = false;
      sessionOver = false;
      return;
    }

    if (lastMap && !(ev.type === 'unit_finished' && ev.tracker.kind === 'map')) {
      // The map unit is the very next event after the map's tracker_finished.
      if (lastMap.units === 0) bad.push(`#${i}: map finished at #${lastMap.idx} not followed by its unit`);
      lastMap = null;
    }

    if (ev.type === 'tracker_finished') {
      const t = ev.tracker;
      if (t.kind === 'session') {
        if (!inReset) {
          const left = finished.filter(f => f.claimed === 0);
          for (const f of left) bad.push(`#${i}: session finished with unclaimed ${f.snap.seasonalType} finished at #${f.idx}`);
        }
        sessionOver = true;
        finished = [];
        return;
      }
      if (inReset) return;
      if (t.kind === 'map') lastMap = {idx: i, snap: t, ts: ev.timestamp, units: 0};
      else finished.push({idx: i, snap: t, ts: ev.timestamp, claimed: 0});
      return;
    }

    if (ev.type !== 'unit_finished') return;

    if (inReset) { bad.push(`#${i}: unit_finished emitted by a reset`); return; }
    if (sessionOver) bad.push(`#${i}: unit_finished after the session tracker_finished`);

    const u = ev;
    if (u.tracker.kind === 'map') {
      if (!lastMap) { bad.push(`#${i}: map unit with no map tracker_finished right before it`); return; }
      lastMap.units++;
      if (!same(lastMap.snap, u.tracker)) bad.push(`#${i}: map unit snapshot differs from the map's tracker_finished`);
      if (lastMap.ts !== u.timestamp) bad.push(`#${i}: map unit timestamp ${u.timestamp} != finish ${lastMap.ts}`);
      let prev = -Infinity;
      for (const o of u.overlaps) {
        if (o.tracker.kind !== 'seasonal') bad.push(`#${i}: overlap of kind ${o.tracker.kind}`);
        if (o.timestamp > u.timestamp) bad.push(`#${i}: overlap ${o.tracker.seasonalType} ts ${o.timestamp} > map unit ${u.timestamp}`);
        const f = claim(o.tracker, o.timestamp, `#${i} overlap`, i);
        if (f && f.idx < prev) bad.push(`#${i}: overlaps out of finish order`);
        if (f) prev = f.idx;
      }
      lastMap = null;                       // consumed; a 2nd unit would hit "no map right before"
      // (re-set a tombstone so that a duplicate is reported as such)
      return;
    }

    // standalone seasonal
    if (u.tracker.kind !== 'seasonal') bad.push(`#${i}: unit primary of kind ${u.tracker.kind}`);
    if (u.overlaps.length !== 0) bad.push(`#${i}: standalone ${u.tracker.seasonalType} carries overlaps`);
    claim(u.tracker, u.timestamp, `#${i} standalone`, i);
  });

  if (lastMap && (lastMap as {units: number}).units === 0) bad.push(`end: map finished at #${(lastMap as {idx: number}).idx} has no unit`);
  return bad;
}

/** Unit totals: every unit's primary is a map or one standalone; counts overlaps. */
export function countUnitRuns(events: ReadonlyArray<EngineEvent>): number {
  let n = 0;
  for (const e of events) if (e.type === 'unit_finished') n += 1 + e.overlaps.length;
  return n;
}
