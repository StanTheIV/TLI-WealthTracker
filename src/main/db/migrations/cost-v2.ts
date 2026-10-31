/**
 * Migration v2 (`cost-on-map`) — the pure per-session transform. No DB access.
 *
 * Before v2 the town buffer at map entry was published as loot: the consumed
 * materials sat in the map row's `drops` (and the session's `drops` /
 * `dropsBySource`) as NEGATIVES, while the row's `spent` held the same basket
 * as positive magnitudes. From v2 the entry cost lives only in `spent`
 * (row and session), so the negatives are added back.
 *
 * Row rule (primary rows only; overlap rows are never touched or counted):
 *   - `spent` empty → nothing to do.
 *   - some `spent` id is NOT an own key of `drops` → STALE: the basket was never
 *     credited to this row (a copy of the previous row's basket — paused entry,
 *     or the old snapshot surviving an entry with an empty buffer). Cleared to
 *     `spent = {}`, drops untouched.
 *   - otherwise `drops[id] += spent[id]` (keys reaching 0 deleted); `spent` kept.
 * Session rule, with tot = Σ migrated rows' spent:
 *   - `drops[id] += tot[id]` (zeros deleted); `spent = tot`.
 *   - `dropsBySource` (only when non-empty): each id's tot is restored where its
 *     negatives sit — the `map` bucket first, then the other buckets in sorted
 *     key order, each up to its negative's magnitude; any remainder goes into
 *     `map`. Zeros deleted; emptied buckets kept (an empty `dropsBySource`
 *     would re-date an exclusive-era session as legacy when v5 classifies it).
 *
 * Lossy cases this cannot repair (left as they are):
 *   - interlude entry cost: maps entered and then frozen for an Arcana / Vorex /
 *     Tartarus interlude had `spent {}` with the cost only as negative drops —
 *     nothing says which negatives were the cost;
 *   - an unsaved in-flight map's cost (the session ended mid-map; no row);
 *   - town-buffer positives that were booked as loot at map entry;
 *   - entry-cost negatives booked to a seasonal bucket beyond what `spent`
 *     restores (a live seasonal writer at map entry; the stale-copy rows);
 *   - stale rows: their real cost, if any, is unknown, so it becomes `{}`.
 *
 * Every map is handled by own keys and rebuilt with `Object.fromEntries`, so
 * ids such as `__proto__` or `constructor` behave like any other.
 */

export type Counts = Record<string, number>;

export interface CostSessionIn {
  drops:         Counts;
  dropsBySource: Record<string, Counts>;
  attribution:   string;
}

export interface CostRowIn {
  id:        number;
  drops:     Counts;
  spent:     Counts;
  /** `parent_map_index IS NULL` — a map or a standalone seasonal. */
  isPrimary: boolean;
}

export interface CostRowOut {
  id:    number;
  drops: Counts;
  spent: Counts;
}

export interface CostStats {
  /** Primary rows whose cost was added back into their drops. */
  rowsMigrated:     number;
  /** Primary rows whose `spent` was a stale copy and is now `{}`. */
  staleRowsCleared: number;
}

export interface CostSessionOut {
  session: {drops: Counts; dropsBySource: Record<string, Counts>; spent: Counts};
  /** Changed rows only. */
  rows:    CostRowOut[];
  stats:   CostStats;
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const toMap  = (o: Counts): Map<string, number> => new Map(Object.entries(o));

/** Add `qty` to `key`, deleting it when it lands on 0. */
function bump(m: Map<string, number>, key: string, qty: number): void {
  const next = (m.get(key) ?? 0) + qty;
  if (next === 0) m.delete(key);
  else            m.set(key, next);
}

export function migrateSessionCost(session: CostSessionIn, rows: readonly CostRowIn[]): CostSessionOut {
  const tot  = new Map<string, number>();
  const out: CostRowOut[] = [];
  const stats: CostStats = {rowsMigrated: 0, staleRowsCleared: 0};

  for (const row of rows) {
    if (!row.isPrimary) continue;
    const spent = Object.entries(row.spent);
    if (spent.length === 0) continue;

    if (spent.some(([id]) => !hasOwn(row.drops, id))) {
      out.push({id: row.id, drops: Object.fromEntries(Object.entries(row.drops)), spent: {}});
      stats.staleRowsCleared++;
      continue;
    }

    const drops = toMap(row.drops);
    for (const [id, qty] of spent) {
      bump(drops, id, qty);
      tot.set(id, (tot.get(id) ?? 0) + qty);
    }
    out.push({id: row.id, drops: Object.fromEntries(drops), spent: Object.fromEntries(spent)});
    stats.rowsMigrated++;
  }

  const drops = toMap(session.drops);
  for (const [id, qty] of tot) bump(drops, id, qty);

  return {
    session: {
      drops:         Object.fromEntries(drops),
      dropsBySource: restoreBySource(session.dropsBySource, tot),
      spent:         Object.fromEntries(tot),
    },
    rows: out,
    stats,
  };
}

/** Put each id's restored cost back where its negatives were booked. */
function restoreBySource(dbs: Record<string, Counts>, tot: ReadonlyMap<string, number>): Record<string, Counts> {
  const sources = Object.keys(dbs);
  if (sources.length === 0 || tot.size === 0) {
    return Object.fromEntries(Object.entries(dbs).map(([src, bucket]) => [src, Object.fromEntries(Object.entries(bucket))]));
  }

  const buckets = new Map(Object.entries(dbs).map(([src, bucket]) => [src, toMap(bucket)] as const));
  const order   = [...(buckets.has('map') ? ['map'] : []), ...sources.filter(s => s !== 'map').sort()];

  for (const [id, qty] of tot) {
    let left = qty;
    const touched: Map<string, number>[] = [];
    for (const src of order) {
      if (left <= 0) break;
      const bucket = buckets.get(src)!;
      const have   = bucket.get(id) ?? 0;
      if (have >= 0) continue;
      const add = Math.min(left, -have);
      bucket.set(id, have + add);
      touched.push(bucket);
      left -= add;
    }
    if (left > 0) {
      let map = buckets.get('map');
      if (!map) { map = new Map(); buckets.set('map', map); }
      map.set(id, (map.get(id) ?? 0) + left);
      touched.push(map);
    }
    // Zeros are deleted only where this restore landed them; other entries stay as stored.
    for (const bucket of touched) if (bucket.get(id) === 0) bucket.delete(id);
  }

  return Object.fromEntries([...buckets].map(([src, bucket]) => [src, Object.fromEntries(bucket)]));
}
