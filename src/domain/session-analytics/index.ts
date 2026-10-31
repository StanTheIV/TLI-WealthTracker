import type {DbItem, DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {AnalyticsWarning, SessionAnalytics, SessionTotals} from './types';
import {classifyRows, foldMapRows} from './attribution';
import {computeBySource, computeByType, computeConsumed, computeDropped} from './items';
import {computeMechanics} from './mechanics';
import {computeMapNetStats, computePerMap} from './perMap';
import {computeTimeline} from './timeline';
import {
  driftPct, makePriceLookup, perHour, ratio, scaleVal, subVal, valueQty, type TaxConfig,
} from '@/domain/valuation';

export * from './types';
export {MAP_FREEZING_SEASONALS} from './attribution';
export {ZERO_VAL, driftPct, isZeroVal} from '@/domain/valuation';

export interface SessionAnalyticsInput {
  session: DbSession;
  maps:    DbSessionMap[];
  items:   Record<string, DbItem>;
  /** Auction-house cut to value through. Every figure below inherits it from
   *  the price lookup, so no aggregate applies it a second time. */
  tax:     TaxConfig;
}

/** Every section reads from one classification and one fold, so no two can
 *  disagree about how a row was classified or what a map earned on its own. */
export function computeSessionAnalytics({session, maps, items, tax}: SessionAnalyticsInput): SessionAnalytics {
  const warnings: AnalyticsWarning[] = [];
  const drops  = session.drops ?? {};
  const spent  = session.spent ?? {};
  const prices = makePriceLookup(
    items, session.priceSnapshot, tax, new Set([...Object.keys(drops), ...Object.keys(spent)]),
  );

  const classified = classifyRows(maps, prices, warnings);
  const folded     = foldMapRows(classified, session.attribution, warnings);
  const mech       = computeMechanics(session, classified, folded, warnings);
  const perMap     = computePerMap(folded);

  const primaryMapRows = classified.filter(c => c.kind === 'map');
  if (session.mapCount !== primaryMapRows.length) {
    warnings.push({code: 'map-count-mismatch', mapCount: session.mapCount, rows: primaryMapRows.length});
  }

  // Income and cost both come from the session tier's own accumulators
  // (`session.drops`, `session.spent`) — not sums over rows, which would
  // inherit each era's overlap semantics and miss a map still in flight at stop.
  const income = valueQty(drops, prices);
  const cost   = valueQty(spent, prices);
  const net    = subVal(income, cost);

  const {slices: bySource, legacy: legacyBySource} = computeBySource(session, folded, prices);
  const costPerMap = session.mapCount > 0 ? scaleVal(cost, 1 / session.mapCount) : null;

  const dropEntries = Object.entries(drops);

  const totals: SessionTotals = {
    totalSeconds:    session.totalTime,
    mapSeconds:      session.mapTime,
    exclusiveSeasonalSeconds: mech.exclusiveSeasonalSeconds,
    townSeconds:     mech.townSeconds,
    plainMapSeconds: mech.plainMapSeconds,
    mapCount:        session.mapCount,
    income,
    cost,
    net,
    netPerHour:      perHour(net, session.totalTime),
    incomePerHour:   perHour(income, session.totalTime),
    efficiencyPct:   session.totalTime > 0
      ? ((session.totalTime - mech.townSeconds) / session.totalTime) * 100
      : 0,
    costPerMap,
    roiMultiple:     ratio(income, cost),
    breakEvenYield:  costPerMap,
    // Maps only — standalone seasonal runs occupy a map_index without being
    // maps, and counting them would report more unprofitable maps than exist.
    mapsUnprofitable: perMap.filter(p => p.mechanic === 'map' && p.net.live < 0).length,
    uniqueItems:     dropEntries.filter(([, qty]) => qty > 0).length,
    totalQty:        dropEntries.reduce((sum, [, qty]) => (qty > 0 ? sum + qty : sum), 0),
    driftPct:        prices.hasSnapshot ? driftPct(income) : null,
  };

  return {
    meta: {
      sessionId:   session.id,
      attribution: session.attribution,
      hasSnapshot: prices.hasSnapshot,
      noMapRows:   maps.length === 0,
      legacyBySource,
      warnings,
    },
    totals,
    mechanics:   mech.mechanics,
    bySource,
    byType:      computeByType(session, items, prices),
    perMap,
    mapNetStats: computeMapNetStats(perMap),
    dropped:     computeDropped(session, items, prices, session.totalTime),
    consumed:    computeConsumed(session, classified, items, prices),
    timeline:    computeTimeline(classified),
  };
}
