import type {DbItem, DbSession, DbSessionMap} from '@/types/electron';
import type {AnalyticsWarning, SessionAnalytics, SessionTotals} from './types';
import {classifyRows} from './attribution';
import {computeBySource, computeByType, computeConsumed, computeDropped} from './items';
import {computeMechanics} from './mechanics';
import {computeMapNetStats, computePerMap} from './perMap';
import {computeTimeline} from './timeline';
import {
  ZERO_VAL, addVal, driftPct, makePriceLookup, makeValuator, perHour, ratio, scaleVal, subVal,
} from './valuation';

export * from './types';
export {MAP_FREEZING_SEASONALS} from './attribution';
export {ZERO_VAL, driftPct, isZeroVal} from './valuation';

export interface SessionAnalyticsInput {
  session: DbSession;
  maps:    DbSessionMap[];
  items:   Record<string, DbItem>;
}

/** Every section reads from one result, so no two can disagree about how a row
 *  was classified. */
export function computeSessionAnalytics({session, maps, items}: SessionAnalyticsInput): SessionAnalytics {
  const warnings: AnalyticsWarning[] = [];
  const prices    = makePriceLookup(items, session.priceSnapshot, Object.keys(session.drops ?? {}));
  const valIncome = makeValuator(prices, {clampNegative: true});

  const classified = classifyRows(maps, valIncome, warnings);
  const mech       = computeMechanics(session, classified, warnings);
  const perMap     = computePerMap(session, classified);

  const primaryMapRows = classified.filter(c => c.kind === 'map');
  if (session.mapCount !== primaryMapRows.length) {
    warnings.push({code: 'map-count-mismatch', mapCount: session.mapCount, rows: primaryMapRows.length});
  }

  // Session income comes from `session.drops`, the independent session-tier
  // accumulator — not a sum over rows, which would inherit each era's overlap
  // semantics. Cost has no such umbrella and must be summed from the rows.
  const income = valIncome(session.drops ?? {});
  const cost   = classified.reduce((acc, c) => addVal(acc, c.cost), ZERO_VAL);
  const net    = subVal(income, cost);

  const {slices: bySource, legacy: legacyBySource} = computeBySource(session, classified, prices);
  const costPerMap = session.mapCount > 0 ? scaleVal(cost, 1 / session.mapCount) : null;

  const dropEntries = Object.entries(session.drops ?? {});

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
    consumed:    computeConsumed(classified, items, prices, session.mapCount),
    timeline:    computeTimeline(classified),
  };
}
