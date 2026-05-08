import type {EngineContext} from './context';
import type {EmitFn} from './types';
import type {SeasonalType} from './tracker';

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
 *   - fans out the change to active trackers via ctx.distributeDrop, which
 *     returns the set of trackers that actually accumulated the drop
 *   - emits a `drop` event per change that the session scope accepted
 *   - emits `tracker_update` snapshots ONLY for trackers that changed
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

  // Aggregate which trackers changed across the whole batch so we emit at
  // most one `tracker_update` per affected tracker even if the batch contains
  // many drops.
  let mapChanged              = false;
  let sessionChanged          = false;
  const seasonalsChanged: Set<SeasonalType> = new Set();

  for (const [itemId, change] of drops) {
    if (change === 0) continue;

    const idStr = String(itemId);
    if (!ctx.knownItems.has(idStr)) {
      ctx.knownItems.add(idStr);
      emit({type: 'new_item', itemId, timestamp: now});
    }

    if (!lootContext) continue;

    const result = ctx.distributeDrop(itemId, change);
    if (result.sessionAccepted) {
      emit({type: 'drop', itemId, change, timestamp: now});
      sessionChanged = true;
    }
    if (result.mapChanged) mapChanged = true;
    for (const t of result.seasonalsChanged) seasonalsChanged.add(t);
  }

  if (mapChanged && ctx.map) {
    emit({type: 'tracker_update', tracker: ctx.map.snapshot(), timestamp: now});
  }
  for (const type of seasonalsChanged) {
    const t = ctx.seasonals.get(type);
    if (t) emit({type: 'tracker_update', tracker: t.snapshot(), timestamp: now});
  }
  if (sessionChanged && ctx.session) {
    emit({type: 'tracker_update', tracker: ctx.session.snapshot(), timestamp: now});
  }
}
