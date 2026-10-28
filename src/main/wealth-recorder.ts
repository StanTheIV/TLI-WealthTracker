import type {Engine} from './engine/engine';
import type {Logger} from './logger';
import type {DbItem, DbWealthDatapoint} from '@/shared/contracts/db';

interface BreakdownEntry {
  qty:   number;
  price: number;
  total: number;
}

export interface WealthRecorderDeps {
  /** Every known item — its `price` values the snapshot (0 when unknown). */
  items:  {getAll(): DbItem[]};
  /** Persists one wealth_datapoints row. */
  insert: (point: DbWealthDatapoint) => void;
  log:    Pick<Logger, 'debug'>;
}

/**
 * Snapshots the engine's current inventory into a wealth_datapoints row.
 * Called on init_complete (initial reading after bag init) and on map_ended
 * (post-map sort settled), so the wealth chart has a datapoint per map.
 *
 * Records GROSS wealth: every bag item with a positive quantity, unfiltered
 * and untaxed. Both are applied at display — the auction tax in `wealthStore`,
 * the item filter from refactor step 4.5 (until then the dashboard shows
 * gross) — so changing either rescales the whole history instead of stepping
 * it. The breakdown keeps each item's id, qty and price, which is all a
 * display-time filter or tax needs to re-derive the value.
 */
export class WealthRecorder {
  private readonly _deps: WealthRecorderDeps;

  constructor(deps: WealthRecorderDeps) {
    this._deps = deps;
  }

  snapshot(engine: Pick<Engine, 'getInventory'>): void {
    const inventory = engine.getInventory();
    const itemMap   = new Map(this._deps.items.getAll().map(i => [i.id, i]));

    const breakdown: Record<string, BreakdownEntry> = {};
    let totalValue = 0;

    for (const [itemId, qty] of inventory) {
      if (qty <= 0) continue;
      const item  = itemMap.get(String(itemId));
      const price = item?.price ?? 0;
      const itemTotal = qty * price;
      breakdown[String(itemId)] = {qty, price, total: itemTotal};
      totalValue += itemTotal;
    }

    this._deps.insert({
      timestamp: Date.now(),
      value:     totalValue,
      breakdown: JSON.stringify(breakdown),
    });

    this._deps.log.debug('wealth', `Wealth snapshot: value=${totalValue}, items=${Object.keys(breakdown).length}`);
  }
}
