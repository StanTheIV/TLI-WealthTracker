import type {EngineContext} from './context';
import type {EmitFn} from './types';

/**
 * Publishes a batch of item deltas through the standard drop pipeline:
 *   - emits `new_item` for first-time items
 *   - fans out to active trackers via ctx.distributeDrop
 *   - emits one `drop` event per change that the session scope accepted
 *   - emits `tracker_update` snapshots for trackers that actually changed
 *
 * The renderer aggregates `drop` events into engineStore.drops (the
 * dashboard's session totals + drop-table fallback). Suppressing filtered
 * drops at the source keeps that aggregate, the live event feed, and the
 * session tracker snapshot consistent — all three honour the session filter.
 *
 * Zero-change entries are skipped. Pass an empty map to no-op.
 */
export function publishDrops(
  ctx:   EngineContext,
  emit:  EmitFn,
  drops: Iterable<[number, number]>,
): void {
  const now     = Date.now();
  let   emitted = false;

  for (const [itemId, change] of drops) {
    if (change === 0) continue;
    emitted = true;

    const idStr = String(itemId);
    if (!ctx.knownItems.has(idStr)) {
      ctx.knownItems.add(idStr);
      emit({type: 'new_item', itemId, timestamp: now});
    }

    const sessionAccepted = ctx.distributeDrop(itemId, change);
    // Gate the renderer-facing `drop` event on the session scope decision.
    // The renderer's engineStore.drops aggregate is the session-level view,
    // so a drop the session filter rejected must not appear there or in the
    // live event feed — otherwise the dashboard contradicts the session
    // tracker snapshot.
    if (sessionAccepted) {
      emit({type: 'drop', itemId, change, timestamp: now});
    }
  }

  if (!emitted) return;

  if (ctx.map)      emit({type: 'tracker_update', tracker: ctx.map.snapshot(),      timestamp: now});
  if (ctx.seasonal) emit({type: 'tracker_update', tracker: ctx.seasonal.snapshot(), timestamp: now});
  if (ctx.session)  emit({type: 'tracker_update', tracker: ctx.session.snapshot(),  timestamp: now});
}
