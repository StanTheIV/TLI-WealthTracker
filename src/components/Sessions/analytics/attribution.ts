import type {DbSession, DbSessionMap, SeasonalPhase, SeasonalType} from '@/types/electron';
import type {AnalyticsWarning, ClassifiedRow, MechanicKey, Valuator} from './types';

/** Seasonals that FREEZE the map clock, so their time is NOT inside
 *  session.mapTime — even though the engine still writes them as overlap rows
 *  (hasActiveMapTracker() tests `map !== null`, true while merely paused).
 *  Mirrors the callers of `pauseMapForInterlude`; add a mechanic here when it
 *  starts calling that, or its time is subtracted from map time it never
 *  belonged to. Sandlord's entry covers its HUB phase only — its in-map coin
 *  tile freezes nothing — so test membership via `runsConcurrentlyWithMap`,
 *  which knows about phases, rather than reading this set directly. */
export const MAP_FREEZING_SEASONALS: ReadonlySet<SeasonalType> =
  new Set<SeasonalType>(['arcana', 'vorex', 'sandlord']);

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
  valueIncome: Valuator,
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
      income:  valueIncome(row.drops),
      cost:    valueIncome(row.spent),
      seconds: Math.max(0, row.duration / 1000),
    };
  });
}
