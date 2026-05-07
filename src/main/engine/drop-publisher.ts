import type {EngineContext} from './context';
import type {EmitFn} from './types';

/**
 * Publishes a batch of item deltas through the standard drop pipeline.
 *
 * `new_item` is emitted for every first-seen itemId regardless of context —
 * the items store keys off this, and an item appearing for the first time in
 * town (vendor purchase, etc.) should still register so future price lookups
 * have a row to update.
 *
 * When `lootContext` is true (in a regular map, a bubble seasonal, or
 * flushing a town buffer into a freshly-entered loot context):
 *   - fans out the change to active trackers via ctx.distributeDrop
 *   - emits a `drop` event per change that the session scope accepted
 *   - emits `tracker_update` snapshots for trackers that actually changed
 *
 * When `lootContext` is false (town activity that settled with no loot
 * context active):
 *   - skips tracker fan-out and the `drop` event entirely
 *   - skips `tracker_update` (no tracker changed)
 *
 * Zero-change entries are skipped. Pass an empty map to no-op.
 */
export function publishDrops(
  ctx:   EngineContext,
  emit:  EmitFn,
  drops: Iterable<[number, number]>,
  opts:  {lootContext: boolean},
): void {
  const now            = Date.now();
  const {lootContext}  = opts;
  let   trackerChanged = false;

  for (const [itemId, change] of drops) {
    if (change === 0) continue;

    const idStr = String(itemId);
    if (!ctx.knownItems.has(idStr)) {
      ctx.knownItems.add(idStr);
      emit({type: 'new_item', itemId, timestamp: now});
    }

    if (!lootContext) continue;

    const sessionAccepted = ctx.distributeDrop(itemId, change);
    trackerChanged = true;
    if (sessionAccepted) {
      emit({type: 'drop', itemId, change, timestamp: now});
    }
  }

  if (!trackerChanged) return;

  if (ctx.map)      emit({type: 'tracker_update', tracker: ctx.map.snapshot(),      timestamp: now});
  if (ctx.seasonal) emit({type: 'tracker_update', tracker: ctx.seasonal.snapshot(), timestamp: now});
  if (ctx.session)  emit({type: 'tracker_update', tracker: ctx.session.snapshot(),  timestamp: now});
}
