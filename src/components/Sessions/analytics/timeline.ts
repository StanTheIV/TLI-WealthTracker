import type {ClassifiedRow, TimelineSegment} from './types';

/** Ordered by `mapIndex`, never `startedAt`: persistence derives the latter as
 *  `end - activeTime`, so a paused run can sort ahead of its own parent. */
export function computeTimeline(classified: ClassifiedRow[]): TimelineSegment[] {
  const childrenByParent = new Map<number, TimelineSegment[]>();

  for (const c of classified) {
    if (c.kind !== 'overlap-seasonal' || c.parent === null) continue;
    const list = childrenByParent.get(c.parent.mapIndex) ?? [];
    list.push({
      key:      `${c.row.mapIndex}:${c.mechanic}:${list.length}`,
      mapIndex: c.row.mapIndex,
      mechanic: c.mechanic,
      kind:     c.kind,
      seconds:  c.seconds,
      income:   c.income,
      cost:     c.cost,
      children: [],
    });
    childrenByParent.set(c.parent.mapIndex, list);
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
      kind:     c.kind,
      seconds:  c.seconds,
      income:   c.income,
      cost:     c.cost,
      children: childrenByParent.get(c.row.mapIndex) ?? [],
    }));
}
