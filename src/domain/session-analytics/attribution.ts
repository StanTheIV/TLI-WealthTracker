import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {SeasonalPhase, SeasonalType} from '@/shared/contracts/engine';
import type {AnalyticsWarning, ClassifiedRow, FoldedRow, MechanicKey, PriceLookup, Valuation} from './types';
import {ZERO_VAL, addVal, isZeroVal, subVal, valueQty} from '@/domain/valuation';

/** Seasonals that FREEZE the map clock, so their time is NOT inside
 *  session.mapTime — even though the engine still writes them as overlap rows
 *  (hasActiveMapTracker() tests `map !== null`, true while merely paused).
 *  Mirrors the callers of `pauseMapForInterlude`; add a mechanic here when it
 *  starts calling that, or its time is subtracted from map time it never
 *  belonged to. Sandlord's entry covers its HUB phase only — its in-map coin
 *  tile freezes nothing — so test membership via `runsConcurrentlyWithMap`,
 *  which knows about phases, rather than reading this set directly. */
export const MAP_FREEZING_SEASONALS: ReadonlySet<SeasonalType> =
  new Set<SeasonalType>(['arcana', 'vorex', 'tartarus', 'sandlord']);

/** `phase` matters only for Sandlord, whose two phases share one seasonal type.
 *  LEGACY: a null phase on a sandlord row predates in-map tracking and means
 *  'hub' — never 'map'. */
export function runsConcurrentlyWithMap(
  type:  SeasonalType | null,
  phase: SeasonalPhase | null = null,
): boolean {
  if (type === null) return false;
  if (type === 'sandlord') return phase === 'map';
  return !MAP_FREEZING_SEASONALS.has(type);
}

/** True when a parent map row's drops already include its overlap seasonals'.
 *  Only the `exclusive` era wrote them disjointly. */
export function parentContainsOverlap(attribution: DbSession['attribution']): boolean {
  return attribution !== 'exclusive';
}

/** Attribution era deliberately plays no part here: overlap rows carry honest
 *  durations in every era, and only *value* aggregation branches on it. Mixing
 *  the two is the bug this split exists to prevent. */
export function classifyRows(
  maps: DbSessionMap[],
  prices: PriceLookup,
  warnings: AnalyticsWarning[],
): ClassifiedRow[] {
  const primaryByIndex = new Map<number, DbSessionMap>();
  for (const row of maps) {
    if (row.parentMapIndex == null) primaryByIndex.set(row.mapIndex, row);
  }

  return maps.map(row => {
    const isOverlap = row.parentMapIndex != null;
    const parent    = isOverlap ? primaryByIndex.get(row.parentMapIndex!) ?? null : null;

    if (isOverlap && parent === null) {
      // Parent never resolved (partial delete, or the defensive window in
      // SessionPersistence before any primary row exists). Treat as standalone
      // so its time and value stay in the aggregates instead of vanishing.
      warnings.push({code: 'orphan-overlap-row', mapIndex: row.mapIndex});
    }

    if (row.seasonalType === null && isOverlap) {
      warnings.push({code: 'unknown-seasonal-type', mapIndex: row.mapIndex});
    }

    const resolvedOverlap = isOverlap && parent !== null;
    const kind = row.seasonalType === null && !isOverlap
      ? 'map' as const
      : resolvedOverlap ? 'overlap-seasonal' as const : 'standalone-seasonal' as const;

    const mechanic: MechanicKey = kind === 'map'
      ? 'map'
      : (row.seasonalType ?? 'unknown');

    return {
      row,
      kind,
      mechanic,
      concurrentWithMap: kind === 'overlap-seasonal' && runsConcurrentlyWithMap(row.seasonalType, row.phase),
      parent,
      income:  valueQty(row.drops, prices),
      cost:    valueQty(row.spent, prices),
      seconds: Math.max(0, row.duration / 1000),
    };
  });
}

/** THE fold, computed once per analytics pass: each primary or standalone row
 *  with its overlaps attached — each overlap to exactly the one parent row
 *  `classifyRows` resolved for it. Outside `exclusive`, a parent map row already
 *  holds its overlaps' drops, so they are taken back out of it. Only CONCURRENT
 *  overlaps qualify — drop-through requires an active map, so an interlude
 *  mechanic's loot never reached its parent and folding it would erase real
 *  map income. Cost plays no part: it lives on the row's `spent`, never in its
 *  drops, so there is nothing to add back. Nothing is clamped either — an
 *  overlap that recorded more than its parent (historical late loot) leaves a
 *  negative own income and one `overlap-exceeds-parent` warning. */
export function foldMapRows(
  classified: ClassifiedRow[],
  attribution: DbSession['attribution'],
  warnings: AnalyticsWarning[],
): FoldedRow[] {
  const fold = parentContainsOverlap(attribution);
  // Keyed by the resolved parent ROW, never its mapIndex: duplicate primaries
  // (continued sessions) share an index, and keying by it would attach one
  // overlap to every one of them — counting its income once per duplicate.
  const overlapsByParent = new Map<DbSessionMap, ClassifiedRow[]>();
  for (const c of classified) {
    if (c.kind !== 'overlap-seasonal' || c.parent === null) continue;
    const list = overlapsByParent.get(c.parent) ?? [];
    list.push(c);
    overlapsByParent.set(c.parent, list);
  }

  const out: FoldedRow[] = [];
  for (const c of classified) {
    if (c.kind === 'overlap-seasonal') continue;

    const bySeasonal: Partial<Record<MechanicKey, Valuation>> = {};
    let seasonalIncome = ZERO_VAL;
    let foldedOut      = ZERO_VAL;
    for (const o of overlapsByParent.get(c.row) ?? []) {
      bySeasonal[o.mechanic] = addVal(bySeasonal[o.mechanic] ?? ZERO_VAL, o.income);
      seasonalIncome = addVal(seasonalIncome, o.income);
      if (fold && o.concurrentWithMap) foldedOut = addVal(foldedOut, o.income);
    }

    let ownIncome: Valuation;
    if (c.kind === 'standalone-seasonal') {
      // The whole row belongs to its mechanic, not to a map.
      bySeasonal[c.mechanic] = addVal(bySeasonal[c.mechanic] ?? ZERO_VAL, c.income);
      seasonalIncome = addVal(seasonalIncome, c.income);
      ownIncome = ZERO_VAL;
    } else {
      ownIncome = subVal(c.income, foldedOut);
      if (!isZeroVal(foldedOut) && (ownIncome.live < -1e-6 || ownIncome.snapshot < -1e-6)) {
        warnings.push({code: 'overlap-exceeds-parent', mapIndex: c.row.mapIndex});
      }
    }

    out.push({
      row: c,
      ownIncome,
      seasonalIncome,
      bySeasonal,
      foldedOut,
      cost: c.cost,
      net:  subVal(addVal(ownIncome, seasonalIncome), c.cost),
    });
  }
  return out;
}
