/** Pure helpers for reading which chart point a pointer event refers to. */
import type {MouseHandlerDataParam} from 'recharts';

/**
 * The data index of the point the tooltip is on, or null when none is.
 * Recharts reports the index as a number or a numeric string, and as null (or
 * a stale value with `isTooltipActive` false) when no point is active —
 * `Number(null)` would silently be 0, the first point.
 */
export function activePointIndex(state: Pick<MouseHandlerDataParam, 'isTooltipActive' | 'activeTooltipIndex'>): number | null {
  if (!state.isTooltipActive) return null;
  const raw = state.activeTooltipIndex;
  if (raw === null || raw === undefined || raw === '') return null;
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : null;
}
