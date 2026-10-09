/** League (season) date model. Pure; shared by main and renderer. */

export type LeagueSource = 'bundled' | 'remote' | 'user';

export type League = {
  id: string;
  name: string;
  /** ms epoch */
  startsAt: number;
  source: LeagueSource;
};

export type LeagueRange = {
  id: string;
  name: string;
  source: LeagueSource;
  /** inclusive, ms epoch */
  from: number;
  /** exclusive (next league's start); null for the latest league */
  to: number | null;
};

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
const SOURCE_RANK: Record<LeagueSource, number> = {bundled: 0, remote: 1, user: 2};

/** Ranges sorted by start; each league ends where the next begins. */
export function leagueRanges(leagues: League[]): LeagueRange[] {
  const sorted = [...leagues].sort((a, b) => a.startsAt - b.startsAt);
  return sorted.map((l, i) => ({
    id: l.id,
    name: l.name,
    source: l.source,
    from: l.startsAt,
    to: i + 1 < sorted.length ? sorted[i + 1].startsAt : null,
  }));
}

/** Range containing `ts` (half-open [from, to)); undefined before the first league. */
export function leagueAt(ranges: LeagueRange[], ts: number): LeagueRange | undefined {
  for (const r of ranges) {
    if (ts >= r.from && (r.to === null || ts < r.to)) return r;
  }
  return undefined;
}

export function currentLeague(ranges: LeagueRange[], now: number): LeagueRange | undefined {
  return leagueAt(ranges, now);
}

/**
 * Reconcile stored league rows with official (bundled/remote) rows.
 * - A stored row with the same id is not replaced by a lower-priority source
 *   (remote beats bundled; remote is never downgraded to bundled).
 * - Only rows that actually change are emitted as upserts.
 * - Stored user rows within ±7 days of any official start are deleted (official date wins).
 */
export function mergeLeagues(
  stored: League[],
  official: League[],
): {upserts: League[]; deletes: string[]} {
  const storedById = new Map(stored.map(l => [l.id, l]));

  // Collapse duplicate ids inside `official` by priority (later wins on ties).
  const best = new Map<string, League>();
  for (const o of official) {
    const cur = best.get(o.id);
    if (!cur || SOURCE_RANK[o.source] >= SOURCE_RANK[cur.source]) best.set(o.id, o);
  }

  const upserts: League[] = [];
  const effective = new Map<string, League>(); // official rows as they exist after the merge
  for (const o of best.values()) {
    const cur = storedById.get(o.id);
    if (cur && cur.source !== 'user' && SOURCE_RANK[cur.source] > SOURCE_RANK[o.source]) {
      effective.set(cur.id, cur);
      continue;
    }
    if (cur && cur.name === o.name && cur.startsAt === o.startsAt && cur.source === o.source) {
      effective.set(cur.id, cur);
      continue;
    }
    upserts.push(o);
    effective.set(o.id, o);
  }
  // Stored official rows not mentioned in `official` still count as official dates.
  for (const s of stored) {
    if (s.source !== 'user' && !effective.has(s.id)) effective.set(s.id, s);
  }

  const officialStarts = [...effective.values()].map(l => l.startsAt);
  const deletes = stored
    .filter(
      s =>
        s.source === 'user' &&
        !best.has(s.id) &&
        officialStarts.some(t => Math.abs(t - s.startsAt) <= SEVEN_DAYS_MS),
    )
    .map(s => s.id);

  return {upserts, deletes};
}

/**
 * Defensive parser for `{version, leagues:[{id,name,startsAt:ISO}]}`.
 * Remote content is untrusted: invalid entries are skipped, never thrown on.
 */
export function parseLeaguesJson(json: unknown, source: 'bundled' | 'remote'): League[] {
  if (!json || typeof json !== 'object') return [];
  const list = (json as {leagues?: unknown}).leagues;
  if (!Array.isArray(list)) return [];
  const out: League[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const {id, name, startsAt} = e as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || id.length > 64) continue;
    if (typeof name !== 'string' || !name.trim() || name.length > 100) continue;
    if (typeof startsAt !== 'string') continue;
    const ms = Date.parse(startsAt);
    if (!Number.isFinite(ms)) continue;
    const cleanId = id.trim();
    if (seen.has(cleanId)) continue;
    seen.add(cleanId);
    out.push({id: cleanId, name: name.trim(), startsAt: ms, source});
  }
  return out;
}

/** A price is stale when it was observed before the current league began. */
export function isStalePrice(
  item: {price: number; priceDate: number},
  current: LeagueRange | undefined,
): boolean {
  return !!current && item.price > 0 && item.priceDate > 0 && item.priceDate < current.from;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** ms epoch -> value for `<input type="datetime-local">` (local time, minute precision). */
export function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `<input type="datetime-local">` value (interpreted as local time) -> ms epoch; null if invalid. */
export function fromLocalInputValue(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const ts = new Date(y, mo - 1, d, h, mi).getTime();
  return Number.isFinite(ts) ? ts : null;
}
