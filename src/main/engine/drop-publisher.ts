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
 * When `lootContext` is true, the change is fanned out via the registry
 * (which applies per-scope filter rules), and `tracker_update` is emitted only
 * for trackers that actually accumulated the drop. When false, fan-out is
 * skipped entirely (town activity).
 */
export function publishDrops(
  ctx:   EngineContext,
  emit:  EmitFn,
  drops: Iterable<[number, number]>,
  opts:  {lootContext: boolean},
): void {
  const now            = Date.now();
  const {lootContext}  = opts;

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

    const result = ctx.registry.distributeDrop(itemId, change, ctx.filter);
    if (result.sessionAccepted) {
      emit({type: 'drop', itemId, change, timestamp: now});
      sessionChanged = true;
    }
    if (result.mapChanged) mapChanged = true;
    for (const t of result.seasonalsChanged) seasonalsChanged.add(t);
  }

  if (mapChanged && ctx.registry.map) {
    emit({type: 'tracker_update', tracker: ctx.registry.map.snapshot(), timestamp: now});
  }
  for (const type of seasonalsChanged) {
    const t = ctx.registry.seasonal(type);
    if (t) emit({type: 'tracker_update', tracker: t.snapshot(), timestamp: now});
  }
  if (sessionChanged && ctx.registry.session) {
    emit({type: 'tracker_update', tracker: ctx.registry.session.snapshot(), timestamp: now});
  }
}
