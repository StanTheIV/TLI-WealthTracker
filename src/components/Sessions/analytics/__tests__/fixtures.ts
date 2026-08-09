import type {DbItem, DbSession, DbSessionMap, SeasonalType} from '@/types/electron';

export function makeSession(over: Partial<DbSession> = {}): DbSession {
  return {
    id:            's1',
    name:          'Session',
    savedAt:       '2026-08-08T12:00:00.000Z',
    totalTime:     600,
    mapTime:       300,
    mapCount:      1,
    drops:         {},
    dropsBySource: {} as DbSession['dropsBySource'],
    attribution:   'drop-through',
    priceSnapshot: {},
    ...over,
  };
}

let nextIndex = 1;

export function resetRowIndex(): void {
  nextIndex = 1;
}

export function makeRow(over: Partial<DbSessionMap> = {}): DbSessionMap {
  // Spread first, then set mapIndex — an explicit `mapIndex: undefined` in
  // `over` would otherwise clobber the allocated index.
  const merged = {
    sessionId:      's1',
    duration:       60_000,
    drops:          {},
    spent:          {},
    seasonalType:   null,
    parentMapIndex: null,
    ...over,
  };
  const mapIndex = merged.mapIndex ?? nextIndex++;
  return {
    ...merged,
    mapIndex,
    startedAt: merged.startedAt ?? 1_000_000 + mapIndex * 1000,
  } as DbSessionMap;
}

/** A plain map row. `seconds` and drop/spend dicts are the usual variables. */
export function mapRow(seconds: number, drops: Record<string, number> = {}, spent: Record<string, number> = {}, mapIndex?: number): DbSessionMap {
  return makeRow({duration: seconds * 1000, drops, spent, mapIndex});
}

/** An overlap seasonal nested inside `parent`. */
export function overlapRow(type: SeasonalType, seconds: number, parent: number, drops: Record<string, number> = {}): DbSessionMap {
  return makeRow({
    mapIndex:       parent,
    parentMapIndex: parent,
    seasonalType:   type,
    duration:       seconds * 1000,
    drops,
  });
}

/** A standalone seasonal run with no enclosing map. */
export function standaloneRow(type: SeasonalType, seconds: number, drops: Record<string, number> = {}, spent: Record<string, number> = {}, mapIndex?: number): DbSessionMap {
  return makeRow({seasonalType: type, duration: seconds * 1000, drops, spent, mapIndex});
}

/** Item table where each id is priced at its numeric value ×1 for easy maths. */
export function makeItems(prices: Record<string, number>, types: Record<string, string> = {}): Record<string, DbItem> {
  const out: Record<string, DbItem> = {};
  for (const [id, price] of Object.entries(prices)) {
    out[id] = {id, name: `Item ${id}`, type: types[id] ?? 'other', price, priceDate: 0};
  }
  return out;
}
