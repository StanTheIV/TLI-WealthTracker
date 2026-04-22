import type {EngineContext} from './context';
import type {EmitFn} from './types';

/**
 * Publishes a batch of item deltas through the standard drop pipeline:
 *   - emits `new_item` for first-time items
 *   - fans out to active trackers via ctx.distributeDrop
 *   - emits one `drop` event per change
 *   - emits `tracker_update` snapshots for map and session
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

    ctx.distributeDrop(itemId, change);
    emit({type: 'drop', itemId, change, timestamp: now});
  }

  if (!emitted) return;

  if (ctx.map)      emit({type: 'tracker_update', tracker: ctx.map.snapshot(),      timestamp: now});
  if (ctx.seasonal) emit({type: 'tracker_update', tracker: ctx.seasonal.snapshot(), timestamp: now});
  if (ctx.session)  emit({type: 'tracker_update', tracker: ctx.session.snapshot(),  timestamp: now});
}
