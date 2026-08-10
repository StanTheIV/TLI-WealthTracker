import type {DbSession} from '@/types/electron';
import type {AnalyticsWarning, ClassifiedRow, MechanicKey, MechanicStats, Valuation} from './types';
import {parentContainsOverlap} from './attribution';
import {ZERO_VAL, addVal, clampVal, perHour, scaleVal, sharePct, subVal} from './valuation';

/** Display order. Town last — it is a residual, not a mechanic. */
const ORDER: MechanicKey[] = [
  'map', 'lunaria', 'overrealm', 'carjack', 'clockwork', 'dream', 'hunting',
  'sandlord', 'vorex', 'arcana', 'unknown', 'town',
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
 *  durations, value from the rows. Deriving either from the other imports that
 *  source's blind spots. */
export function computeMechanics(
  session: DbSession,
  classified: ClassifiedRow[],
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
  // The ONLY place attribution era matters: outside `exclusive`, a parent map
  // row already holds its overlaps' drops, so they are folded back out of it.
  // Only CONCURRENT overlaps qualify — drop-through requires an active map, so
  // an interlude mechanic's loot never reached its parent and folding it would
  // erase real map income.
  const foldOverlap = parentContainsOverlap(session.attribution);
  const overlapByParent = new Map<number, Valuation>();
  for (const c of classified) {
    if (c.kind !== 'overlap-seasonal' || c.parent === null || !c.concurrentWithMap) continue;
    const prev = overlapByParent.get(c.parent.mapIndex) ?? ZERO_VAL;
    overlapByParent.set(c.parent.mapIndex, addVal(prev, c.income));
  }

  for (const c of classified) {
    const b = bucket(c.mechanic);
    b.runs += 1;
    b.cost = addVal(b.cost, c.cost);

    if (c.kind === 'map') {
      const overlap = overlapByParent.get(c.row.mapIndex) ?? ZERO_VAL;
      if (foldOverlap) {
        const net = subVal(c.income, overlap);
        if (net.live < -1e-6 || net.snapshot < -1e-6) {
          warnings.push({code: 'overlap-exceeds-parent', mapIndex: c.row.mapIndex});
        }
        b.income = addVal(b.income, clampVal(net));
      } else {
        b.income = addVal(b.income, c.income);
      }
    } else {
      b.income = addVal(b.income, c.income);
    }
  }

  // Town has time but structurally no income: drops outside a loot context are
  // discarded outright (docs/LOOT-FLOW.md), so a residual here would be an
  // accounting error, not earnings. Its cost is real — entry materials are
  // bought in town — but they are already attributed to the run they opened.
  bucket('town').runs = 0;

  // -- percentages ---------------------------------------------------------
  // Normalise against the bucket sum rather than session.totalTime so the parts
  // always sum to 100 even when a clamp above absorbed an inconsistency.
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
