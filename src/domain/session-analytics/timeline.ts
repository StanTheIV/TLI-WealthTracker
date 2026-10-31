import type {DbSessionMap} from '@/shared/contracts/db';
import type {ClassifiedRow, TimelineSegment} from './types';

/** Ordered by `mapIndex` (unit order), never `startedAt`: a town-opened panel
 *  reopened in a map really starts before its parent, and older saves derived
 *  `startedAt` as `end - activeTime`, so a paused run read late. */
export function computeTimeline(classified: ClassifiedRow[]): TimelineSegment[] {
  // Keyed by the resolved parent row, not its mapIndex: duplicate primaries
  // share an index, and an overlap belongs under exactly one of them.
  const childrenByParent = new Map<DbSessionMap, TimelineSegment[]>();

  for (const c of classified) {
    if (c.kind !== 'overlap-seasonal' || c.parent === null) continue;
    const list = childrenByParent.get(c.parent) ?? [];
    list.push({
      key:      `${c.row.mapIndex}:${c.mechanic}:${list.length}`,
      mapIndex: c.row.mapIndex,
      mechanic: c.mechanic,
      phase:    c.row.phase,
      kind:     c.kind,
      seconds:  c.seconds,
      income:   c.income,
      cost:     c.cost,
      children: [],
    });
    childrenByParent.set(c.parent, list);
  }

  return classified
    .filter(c => c.kind !== 'overlap-seasonal')
    .sort((a, b) => a.row.mapIndex - b.row.mapIndex)
    .map(c => ({
      // A reclassified orphan keeps its parent's mapIndex, so the index alone
      // is not unique — qualify it with the mechanic.
      key:      `${c.row.mapIndex}:${c.mechanic}`,
      mapIndex: c.row.mapIndex,
      mechanic: c.mechanic,
      phase:    c.row.phase,
      kind:     c.kind,
      seconds:  c.seconds,
      income:   c.income,
      cost:     c.cost,
      children: childrenByParent.get(c.row) ?? [],
    }));
}
