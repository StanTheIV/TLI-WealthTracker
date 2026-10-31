import type {DbSession} from '@/shared/contracts/db';
import type {AnalyticsWarning, ClassifiedRow, FoldedRow, MechanicKey, MechanicStats, Valuation} from './types';
import {ZERO_VAL, addVal, clampVal, perHour, scaleVal, sharePct, subVal} from '@/domain/valuation';

/** Display order. Town last — it is a residual, not a mechanic. */
const ORDER: MechanicKey[] = [
  'map', 'lunaria', 'overrealm', 'carjack', 'clockwork', 'dream', 'hunting',
  'afterlight', 'sandlord', 'vorex', 'tartarus', 'arcana', 'unknown', 'town',
];

interface Bucket {
  runs:    number;
  seconds: number;
  income:  Valuation;
  cost:    Valuation;
  nested:  boolean;
}

const emptyBucket = (): Bucket => ({runs: 0, seconds: 0, income: ZERO_VAL, cost: ZERO_VAL, nested: false});

export interface MechanicsResult {
  mechanics:       MechanicStats[];
  plainMapSeconds: number;
  townSeconds:     number;
  exclusiveSeasonalSeconds: number;
}

/** Time and value come from different authorities on purpose: time from
 *  `session.mapTime` (the map tracker's pause-aware clock) adjusted by row
 *  durations, value from the rows (a map's own income from the fold). Deriving
 *  either from the other imports that source's blind spots. */
export function computeMechanics(
  session: DbSession,
  classified: ClassifiedRow[],
  folded: FoldedRow[],
  warnings: AnalyticsWarning[],
): MechanicsResult {
  const buckets = new Map<MechanicKey, Bucket>();
  const bucket = (key: MechanicKey): Bucket => {
    let b = buckets.get(key);
    if (!b) { b = emptyBucket(); buckets.set(key, b); }
    return b;
  };

  // -- time ----------------------------------------------------------------
  // Concurrent overlaps ran inside the map clock, so they carve out of plain-map
  // time. Everything else (standalones, and the interlude mechanics that froze
  // the map) ran outside it and carves out of town time instead.
  let concurrentSeconds = 0;
  let exclusiveSeconds  = 0;

  for (const c of classified) {
    if (c.kind === 'map') continue;
    const b = bucket(c.mechanic);
    b.seconds += c.seconds;
    if (c.concurrentWithMap) {
      b.nested = true;
      concurrentSeconds += c.seconds;
    } else {
      exclusiveSeconds += c.seconds;
    }
  }

  const mapSeconds = Math.max(0, session.mapTime);
  if (concurrentSeconds > mapSeconds + 1) {
    warnings.push({
      code: 'nested-exceeds-map-time',
      nestedSeconds: concurrentSeconds,
      mapSeconds,
    });
  }

  const plainMapSeconds = Math.max(0, mapSeconds - concurrentSeconds);
  const townSeconds     = Math.max(0, session.totalTime - mapSeconds - exclusiveSeconds);

  bucket('map').seconds = plainMapSeconds;
  bucket('town').seconds = townSeconds;

  // -- value ---------------------------------------------------------------
  // A map row's own income is the fold's (its concurrent overlaps already taken
  // out where the era put them in); every seasonal row keeps its own income.
  for (const c of classified) {
    const b = bucket(c.mechanic);
    b.runs += 1;
    b.cost = addVal(b.cost, c.cost);
    if (c.kind !== 'map') b.income = addVal(b.income, c.income);
  }
  for (const f of folded) {
    if (f.row.kind === 'map') bucket('map').income = addVal(bucket('map').income, f.ownIncome);
  }

  // Town has time but structurally no income: drops outside a loot context are
  // discarded outright (docs/LOOT-FLOW.md), so a residual here would be an
  // accounting error, not earnings. Its cost is real — entry materials are
  // bought in town — but they are already attributed to the run they opened.
  bucket('town').runs = 0;

  // -- percentages ---------------------------------------------------------
  // Normalise against the bucket sum rather than session.totalTime so the parts
  // always sum to 100 even when a clamp above absorbed an inconsistency. Value
  // shares are of the positive incomes only; a negative bucket gets none.
  const accounted = [...buckets.values()].reduce((sum, b) => sum + b.seconds, 0);
  const residual  = session.totalTime - accounted;
  if (Math.abs(residual) > 1) {
    warnings.push({code: 'time-reconciliation', residualSeconds: residual});
  }

  const totalValue = [...buckets.values()].reduce(
    (sum, b) => addVal(sum, clampVal(b.income)),
    ZERO_VAL,
  );

  const mechanics: MechanicStats[] = ORDER
    .filter(key => {
      const b = buckets.get(key);
      return b !== undefined && (b.runs > 0 || b.seconds > 0);
    })
    .map(key => {
      const b   = buckets.get(key)!;
      const net = subVal(b.income, b.cost);
      return {
        key,
        runs:        b.runs,
        seconds:     b.seconds,
        timePct:     accounted > 0 ? (b.seconds / accounted) * 100 : 0,
        income:      b.income,
        cost:        b.cost,
        net,
        valuePct:    sharePct(clampVal(b.income), totalValue),
        fePerHour:   perHour(net, b.seconds),
        avgPerRun:   b.runs > 0 ? scaleVal(net, 1 / b.runs) : ZERO_VAL,
        avgSeconds:  b.runs > 0 ? b.seconds / b.runs : 0,
        nestedInMap: b.nested,
      };
    });

  return {
    mechanics,
    plainMapSeconds,
    townSeconds,
    exclusiveSeasonalSeconds: exclusiveSeconds,
  };
}
