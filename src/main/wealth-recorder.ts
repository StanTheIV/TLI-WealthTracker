import {itemsGetAll, wealthInsert} from './db';
import type {Engine} from './engine/engine';
import {log} from './logger';

interface BreakdownEntry {
  qty:   number;
  price: number;
  total: number;
}

/**
 * Snapshots the engine's current inventory into a wealth_datapoints row.
 * Called on init_complete (initial reading after bag init) and on map_ended
 * (post-map sort settled), so the wealth chart has a datapoint per map.
 *
 * Filter is honoured: items hidden by the active 'wealth' scope rules are
 * excluded from both the breakdown and the totalValue.
 */
export class WealthRecorder {
  private readonly _getEngine:    () => Engine | null;
  private readonly _getSessionId: () => string | null;

  constructor(deps: {
    getEngine:    () => Engine | null;
    getSessionId: () => string | null;
  }) {
    this._getEngine    = deps.getEngine;
    this._getSessionId = deps.getSessionId;
  }

  snapshot(): void {
    const engine = this._getEngine();
    if (!engine) return;

    const inventory = engine.getInventory();
    const itemMap   = new Map(itemsGetAll().map(i => [i.id, i]));
    const filter    = engine.getFilter();

    const breakdown: Record<string, BreakdownEntry> = {};
    let totalValue = 0;

    for (const [itemId, qty] of inventory) {
      if (qty <= 0) continue;
      if (filter && !filter.shouldInclude(itemId, 'wealth')) continue;
      const item  = itemMap.get(String(itemId));
      const price = item?.price ?? 0;
      const itemTotal = qty * price;
      breakdown[String(itemId)] = {qty, price, total: itemTotal};
      totalValue += itemTotal;
    }

    wealthInsert({
      timestamp: Date.now(),
      value:     totalValue,
      sessionId: this._getSessionId(),
      breakdown: JSON.stringify(breakdown),
    });

    log.debug('wealth', `Wealth snapshot: value=${totalValue}, items=${Object.keys(breakdown).length}`);
  }
}
