import type {SqlConn} from './sql-conn';
import type {SeasonalType, SeasonalPhase} from '@/shared/contracts/engine';
import type {DbSession, DbSessionMap, SessionAttribution} from '@/shared/contracts/db';

type SessionRow = {
  id:              string;
  name:            string;
  saved_at:        string;
  total_time:      number;
  map_time:        number;
  map_count:       number;
  drops:           string;
  drops_by_source: string;
  attribution:     string;
  price_snapshot:  string;
  spent:           string;
};

type SessionMapRow = {
  session_id:       string;
  map_index:        number;
  started_at:       number;
  duration:         number;
  drops:            string;
  spent:            string;
  seasonal_type:    string | null;
  parent_map_index: number | null;
  phase:            string | null;
};

function rowToSession(r: SessionRow): DbSession {
  const dropsBySource = JSON.parse(r.drops_by_source ?? '{}');
  // Rows written before the attribution column: dropsBySource was introduced
  // together with exclusive attribution, so its presence dates the row.
  const attribution = (r.attribution || null) as SessionAttribution | null
    ?? (Object.keys(dropsBySource).length === 0 ? 'legacy' : 'exclusive');
  return {
    id:            r.id,
    name:          r.name,
    savedAt:       r.saved_at,
    totalTime:     r.total_time,
    mapTime:       r.map_time,
    mapCount:      r.map_count,
    drops:         JSON.parse(r.drops),
    dropsBySource,
    attribution,
    priceSnapshot: JSON.parse(r.price_snapshot ?? '{}'),
    spent:         JSON.parse(r.spent ?? '{}'),
  };
}

/** JSON-encode a session's object columns for named binding. */
function sessionParams(session: DbSession): Record<string, unknown> {
  return {
    ...session,
    drops:         JSON.stringify(session.drops),
    dropsBySource: JSON.stringify(session.dropsBySource),
    priceSnapshot: JSON.stringify(session.priceSnapshot ?? {}),
    spent:         JSON.stringify(session.spent ?? {}),
  };
}

/**
 * Sole owner of the `sessions` / `session_maps` SQL, over any SqlConn (app,
 * tests, replay). db.ts touches these tables only for clear-all and backfill.
 * `sessions` times are seconds, `session_maps` times ms — passed through as is.
 */
export class SqliteSessionStore {
  constructor(private readonly conn: SqlConn) {}

  /** Run `fn` in one transaction (savepoint when nested). */
  transaction<T>(fn: () => T): T {
    return this.conn.transaction(fn);
  }

  // -- sessions -------------------------------------------------------------

  insertSession(session: DbSession): void {
    this.conn.prepare(`
      INSERT INTO sessions (id, name, saved_at, total_time, map_time, map_count, drops, drops_by_source, attribution, price_snapshot, spent)
      VALUES (@id, @name, @savedAt, @totalTime, @mapTime, @mapCount, @drops, @dropsBySource, @attribution, @priceSnapshot, @spent)
    `).run(sessionParams(session));
  }

  /** Overwrite a saved session's run data (`price_snapshot` replaced whole).
   *  Never writes `name` — the user may rename it during a continued run. */
  updateSessionTotals(session: DbSession): void {
    this.conn.prepare(`
      UPDATE sessions
      SET saved_at = @savedAt, total_time = @totalTime,
          map_time = @mapTime, map_count = @mapCount, drops = @drops,
          drops_by_source = @dropsBySource, attribution = @attribution,
          price_snapshot = @priceSnapshot, spent = @spent
      WHERE id = @id
    `).run(sessionParams(session));
  }

  getSession(id: string): DbSession | null {
    const row = this.conn.prepare('SELECT * FROM sessions WHERE id = ?').get<SessionRow>(id);
    if (!row) return null;
    return rowToSession(row);
  }

  /** Every saved session, newest first. */
  listSessions(): DbSession[] {
    const rows = this.conn.prepare('SELECT * FROM sessions ORDER BY saved_at DESC').all<SessionRow>();
    return rows.map(rowToSession);
  }

  renameSession(id: string, name: string): void {
    this.conn.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
  }

  /** Delete a session and its per-map rows together. */
  deleteSession(id: string): void {
    // Cascade: per-map rows have no FK constraint; clean them up explicitly so
    // deleting a session doesn't leave orphans behind.
    this.conn.transaction(() => {
      this.conn.prepare('DELETE FROM session_maps WHERE session_id = ?').run(id);
      this.conn.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
  }

  /** Add prices the session's snapshot lacks; existing entries are never
   *  overwritten. No-op for an unknown session. */
  mergePriceSnapshot(id: string, prices: Record<string, number>): void {
    this.conn.transaction(() => {
      const row = this.conn.prepare('SELECT price_snapshot FROM sessions WHERE id = ?').get<{price_snapshot: string}>(id);
      if (!row) return;
      const snapshot: Record<string, number> = JSON.parse(row.price_snapshot ?? '{}');
      // Own keys only, and rebuilt via fromEntries (data properties), so ids
      // like "constructor" or "__proto__" behave like any other.
      const missing = Object.entries(prices).filter(([itemId]) => !Object.prototype.hasOwnProperty.call(snapshot, itemId));
      if (missing.length === 0) return;
      const merged = Object.fromEntries([...Object.entries(snapshot), ...missing]);
      this.conn.prepare('UPDATE sessions SET price_snapshot = ? WHERE id = ?').run(JSON.stringify(merged), id);
    });
  }

  // -- session maps ---------------------------------------------------------

  /** Append per-map rows in one transaction. Empty input is a no-op. */
  insertRows(rows: DbSessionMap[]): void {
    if (rows.length === 0) return;
    const stmt = this.conn.prepare(`
      INSERT INTO session_maps (session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase)
      VALUES (@sessionId, @mapIndex, @startedAt, @duration, @drops, @spent, @seasonalType, @parentMapIndex, @phase)
    `);
    this.conn.transaction(() => {
      for (const r of rows) {
        stmt.run({
          ...r,
          drops:          JSON.stringify(r.drops),
          spent:          JSON.stringify(r.spent),
          seasonalType:   r.seasonalType,
          parentMapIndex: r.parentMapIndex,
          phase:          r.phase,
        });
      }
    });
  }

  /** A session's per-map rows in insertion order. */
  getRows(sessionId: string): DbSessionMap[] {
    const rows = this.conn.prepare(
      'SELECT session_id, map_index, started_at, duration, drops, spent, seasonal_type, parent_map_index, phase FROM session_maps WHERE session_id = ? ORDER BY id ASC'
    ).all<SessionMapRow>(sessionId);
    return rows.map(r => ({
      sessionId:      r.session_id,
      mapIndex:       r.map_index,
      startedAt:      r.started_at,
      duration:       r.duration,
      drops:          JSON.parse(r.drops),
      spent:          JSON.parse(r.spent),
      seasonalType:   r.seasonal_type as SeasonalType | null,
      parentMapIndex: r.parent_map_index,
      phase:          r.phase as SeasonalPhase | null,
    }));
  }

  /** Highest mapIndex among a session's primary rows (maps and standalone
   *  seasonals; overlap rows excluded). 0 when it has none. */
  maxPrimaryMapIndex(sessionId: string): number {
    const row = this.conn.prepare(
      'SELECT COALESCE(MAX(map_index), 0) AS n FROM session_maps WHERE session_id = ? AND parent_map_index IS NULL'
    ).get<{n: number}>(sessionId);
    return row?.n ?? 0;
  }
}
