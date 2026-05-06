import type {EngineContext} from './context';
import type {EmitFn} from './types';

/**
 * Publish mode — controls how a batch of bag deltas is routed.
 *
 *   'in-map'  : drops happened inside a map / bubble seasonal — fan out to
 *               session, map, and seasonal trackers.
 *   'pre-map' : drops were buffered in town and just flushed on a town →
 *               loot-context transition. Attribute to session and seasonal,
 *               but NOT to the map tracker — these aren't in-map drops, they
 *               are pre-map spend (e.g. Netherrealm map materials). Stored
 *               separately as `m.spent` in the per-map record.
 *   'town'    : drops settled in town with no subsequent loot context — do
 *               not attribute to any tracker. `new_item` still fires so the
 *               items store stays seeded for vendor-purchased items.
 */
export type PublishMode = 'in-map' | 'pre-map' | 'town';

/**
 * Publishes a batch of item deltas through the standard drop pipeline.
 *
 * `new_item` is emitted for every first-seen itemId regardless of mode —
 * the items store keys off this, and an item appearing for the first time in
 * town (vendor purchase, etc.) should still register so future price lookups
 * have a row to update.
 *
 * For 'in-map' and 'pre-map' modes:
 *   - fans out the change to active trackers via ctx.distributeDrop
 *   - emits a `drop` event per change that the session scope accepted
 *   - emits `tracker_update` snapshots for trackers that actually changed
 *
 * For 'town' mode:
 *   - skips tracker fan-out and the `drop` event entirely
 *   - skips `tracker_update` (no tracker changed)
 *
 * Zero-change entries are skipped. Pass an empty map to no-op.
 */
export function publishDrops(
  ctx:   EngineContext,
  emit:  EmitFn,
  drops: Iterable<[number, number]>,
  opts:  {mode: PublishMode},
): void {
  const now      = Date.now();
  const {mode}   = opts;
  const tracking = mode !== 'town';
  let   trackerChanged = false;

  for (const [itemId, change] of drops) {
    if (change === 0) continue;

    const idStr = String(itemId);
    if (!ctx.knownItems.has(idStr)) {
      ctx.knownItems.add(idStr);
      emit({type: 'new_item', itemId, timestamp: now});
    }

    if (!tracking) continue;

    // Pre-map flushes attribute to session + seasonal but NOT to the map tracker.
    // The pre-map spend lives in the per-map `spent` field instead, sourced
    // from ItemHandler.getLastPreMapFlush() at session-persistence time.
    const sessionAccepted = ctx.distributeDrop(itemId, change, {includeMap: mode === 'in-map'});
    trackerChanged = true;
    if (sessionAccepted) {
      emit({type: 'drop', itemId, change, timestamp: now});
    }
  }

  if (!trackerChanged) return;

  if (mode === 'in-map' && ctx.map) {
    emit({type: 'tracker_update', tracker: ctx.map.snapshot(), timestamp: now});
  }
  if (ctx.seasonal) emit({type: 'tracker_update', tracker: ctx.seasonal.snapshot(), timestamp: now});
  if (ctx.session)  emit({type: 'tracker_update', tracker: ctx.session.snapshot(),  timestamp: now});
}
