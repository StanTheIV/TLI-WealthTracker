/**
 * The whole tracking pipeline over a log, for tests: dispatcher → engine →
 * SessionPersistence → SQLite → analytics. A thin wrapper over `replay()` —
 * the replayer owns the clock and the production wiring; this adds the store,
 * the engine configuration and the analytics pass, and turns the result into a
 * deterministic golden document.
 */
import {computeSessionAnalytics, type SessionAnalytics} from '@/domain/session-analytics';
import {configureEngine} from '@/main/engine/configure-engine';
import {SqliteSessionStore} from '@/main/db/session-store';
import {NO_TAX, liveValue, type TaxConfig} from '@/domain/valuation';
import {readLogText, type LogLine} from '@/replay/log-source';
import {replay, type ControlOp, type ReplayEvent, type ReplayMode} from '@/replay/replay';
import type {Anomaly} from '@/replay/invariants';
import type {DbItem, DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import type {FilterRule} from '@/shared/item-filter';
import {useEngineStore} from '@/state/engineStore';
import {openMigratedNodeSqlite} from './sql/fresh-db';

export interface PipelineOptions {
  controls?:    ControlOp[];
  /** Item table: seeds the engine's known items and types, the price
   *  snapshot at save, and analytics valuation. */
  items?:       Record<string, DbItem>;
  /** The raw settings table, as `configureEngine` reads it. */
  settings?:    Record<string, string>;
  filterRules?: FilterRule[] | null;
  mode?:        ReplayMode;
  settleMs?:    number;
  tax?:         TaxConfig;
}

export interface PipelineSession {
  id:        string;
  /** Null when the run was not saved (30 s rule). */
  session:   DbSession | null;
  rows:      DbSessionMap[];
  analytics: SessionAnalytics | null;
}

export interface PipelineResult {
  sessions:       PipelineSession[];
  events:         ReplayEvent[];
  anomalies:      Anomaly[];
  linesDelivered: number;
  /** Time of the first log line — the origin of every relative time in a golden. */
  firstTs:        number | null;
  lastTs:         number | null;
  /** The item table and tax policy analytics valued through — what the live
   *  invariant must value the overlay's state with. */
  items:          Record<string, DbItem>;
  tax:            TaxConfig;
}

export async function runPipeline(source: string | LogLine[], opts: PipelineOptions = {}): Promise<PipelineResult> {
  const items = opts.items ?? {};
  const tax   = opts.tax ?? NO_TAX;
  const store = new SqliteSessionStore(openMigratedNodeSqlite());

  const result = await replay({
    source:      typeof source === 'string' ? readLogText(source) : source,
    mode:        opts.mode,
    controls:    opts.controls,
    settleMs:    opts.settleMs,
    persistence: {
      store,
      readPrices: ids => {
        const out: Record<string, number> = {};
        for (const id of ids) {
          const item = items[id];
          if (item) out[id] = item.price;
        }
        return out;
      },
    },
    configure: engine => configureEngine(engine, {
      items:       Object.values(items),
      filterRules: opts.filterRules ?? null,
      settings:    opts.settings ?? {},
    }),
  });

  return {
    sessions: result.sessions.map(s => ({
      ...s,
      analytics: s.session ? computeSessionAnalytics({session: s.session, maps: s.rows, items, tax}) : null,
    })),
    events:         result.events,
    anomalies:      result.anomalies,
    linesDelivered: result.linesDelivered,
    firstTs:        result.firstTs,
    lastTs:         result.lastTs,
    items,
    tax,
  };
}

// ---------------------------------------------------------------------------
// Invariants — recorded as data, not asserted
// ---------------------------------------------------------------------------

export interface InvariantResult {
  ok:     boolean;
  /** How far off it is, in the invariant's own unit. Omitted when ok. */
  delta?: number;
}

/** Below this an FE difference is float noise. */
const FE_TOLERANCE = 1e-6;

/**
 * The pipeline's accounting invariants for each saved session, valued on the
 * live price leg:
 * - `netReconciles` — Σ map net + Σ standalone net = session net (FE).
 * - `dropsBySourceSumsToDrops` — the per-source split re-adds to the session's
 *   drops (Σ |difference| over items, in units).
 * - `primaryMapIndexUnique` — no two primary rows share a mapIndex (duplicates).
 * - `overlapHasParent` — every overlap row's parent is a primary row (orphans).
 * - `liveMatchesAnalytics` — the overlay's Total at stop (the real engineStore driven
 *   by the session's engine events, valued by `liveValue`) = session net (FE,
 *   live − analytics).
 * - `mechanicsNetReconciles` — Σ mechanic net = session net (FE).
 * Today's known failures are what the golden files pin; a fix flips them.
 */
export function pipelineInvariants(result: PipelineResult): Record<string, Record<string, InvariantResult>> {
  const out: Record<string, Record<string, InvariantResult>> = {};
  const segments = sessionEventSegments(result.events);
  result.sessions.forEach(({id, session, rows, analytics}, i) => {
    if (!session || !analytics) return;
    out[id] = {
      netReconciles:            netReconciles(analytics),
      dropsBySourceSumsToDrops: dropsBySourceSumsToDrops(session),
      primaryMapIndexUnique:    primaryMapIndexUnique(rows),
      overlapHasParent:         overlapHasParent(rows),
      liveMatchesAnalytics:     liveMatchesAnalytics(segments[i] ?? [], result, analytics),
      mechanicsNetReconciles:   mechanicsNetReconciles(analytics),
    };
  });
  return out;
}

/** Each started run's engine events, in start order — the same order as
 *  `result.sessions`. Every `Engine.start` opens with `init_started`, so that is
 *  the boundary; a stream with none (a crafted one) is a single run. */
function sessionEventSegments(events: ReplayEvent[]): EngineEvent[][] {
  const segments: EngineEvent[][] = [];
  for (const {event} of events) {
    if (event.type === 'init_started' || segments.length === 0) segments.push([]);
    segments[segments.length - 1].push(event);
  }
  // Events ahead of the first `init_started` belong to no run.
  if (segments.length > 1 && segments[0][0]?.type !== 'init_started') segments.shift();
  return segments;
}

function check(delta: number, tolerance = 0): InvariantResult {
  return Math.abs(delta) <= tolerance ? {ok: true} : {ok: false, delta};
}

function netReconciles(a: SessionAnalytics): InvariantResult {
  const rowNet = a.perMap.reduce((sum, p) => sum + p.net.live, 0);
  return check(rowNet - a.totals.net.live, FE_TOLERANCE);
}

function mechanicsNetReconciles(a: SessionAnalytics): InvariantResult {
  const mechanicNet = a.mechanics.reduce((sum, m) => sum + m.net.live, 0);
  return check(mechanicNet - a.totals.net.live, FE_TOLERANCE);
}

/** Replays the run through the renderer's real reducer rather than reading
 *  `session.drops`, which is what analytics read — comparing those would be a
 *  tautology. The store is valued immediately BEFORE the run's session
 *  `tracker_finished` (after the last event when the run has none): that event
 *  replaces the store's `drops` with the final snapshot, which would hide what
 *  the overlay actually shows while running — the `drop`-event accumulation.
 *  So this is the overlay's Total at stop against the saved session's net: they
 *  must agree on state AND on the valuation rule. delta = live − analytics. */
function liveMatchesAnalytics(events: EngineEvent[], result: PipelineResult, a: SessionAnalytics): InvariantResult {
  const finish = events.findIndex(e => e.type === 'tracker_finished' && e.tracker.kind === 'session');
  const upToStop = finish === -1 ? events : events.slice(0, finish);
  useEngineStore.getState().reset();
  for (const event of upToStop) useEngineStore.getState().handleEvent(event);
  const {drops, sessionSpent} = useEngineStore.getState();
  useEngineStore.getState().reset();
  const live = liveValue({drops, spent: sessionSpent}, result.items, result.tax).net;
  return check(live - a.totals.net.live, FE_TOLERANCE);
}

function dropsBySourceSumsToDrops(s: DbSession): InvariantResult {
  const summed: Record<string, number> = {};
  for (const drops of Object.values(s.dropsBySource)) {
    for (const [id, qty] of Object.entries(drops ?? {})) summed[id] = (summed[id] ?? 0) + qty;
  }
  let delta = 0;
  for (const id of new Set([...Object.keys(summed), ...Object.keys(s.drops)])) {
    delta += Math.abs((summed[id] ?? 0) - (s.drops[id] ?? 0));
  }
  return check(delta);
}

function primaryMapIndexUnique(rows: DbSessionMap[]): InvariantResult {
  const primary = rows.filter(r => r.parentMapIndex === null).map(r => r.mapIndex);
  return check(primary.length - new Set(primary).size);
}

function overlapHasParent(rows: DbSessionMap[]): InvariantResult {
  const primary = new Set(rows.filter(r => r.parentMapIndex === null).map(r => r.mapIndex));
  return check(rows.filter(r => r.parentMapIndex !== null && !primary.has(r.parentMapIndex)).length);
}

// ---------------------------------------------------------------------------
// Golden serialisation
// ---------------------------------------------------------------------------

/**
 * A deterministic JSON document of what a log produced: compact engine event
 * lines, each saved session's totals, rows and analytics summary, and the
 * invariants. Times are relative to the first log line (no absolute dates,
 * no savedAt, no name — those vary by run or timezone); keys are sorted,
 * floats rounded to 6 dp.
 */
export function serializeGolden(result: PipelineResult): string {
  const origin = result.firstTs ?? 0;
  const rel = (ts: number) => ts - origin;
  const invariants = pipelineInvariants(result);

  const doc = {
    linesDelivered: result.linesDelivered,
    spanMs:         result.firstTs === null || result.lastTs === null ? 0 : result.lastTs - result.firstTs,
    events:         eventLines(result.events, origin),
    anomalies:      result.anomalies.map(a => ({kind: a.kind, atMs: rel(a.ts), detail: a.detail})),
    sessions:       result.sessions.map(({id, session, rows, analytics}) => ({
      id,
      saved: session !== null,
      ...(session && {
        totals: {
          totalTime:     session.totalTime,
          mapTime:       session.mapTime,
          mapCount:      session.mapCount,
          attribution:   session.attribution,
          drops:         session.drops,
          dropsBySource: session.dropsBySource,
          priceSnapshot: session.priceSnapshot,
          spent:         session.spent,
        },
      }),
      rows: rows.map(({sessionId: _sessionId, startedAt, ...row}) => ({...row, startedAtMs: rel(startedAt)})),
      ...(analytics && {
        analytics: {
          totals:    analytics.totals,
          mechanics: analytics.mechanics,
          perMap:    analytics.perMap,
          warnings:  analytics.meta.warnings,
        },
      }),
      ...(invariants[id] && {invariants: invariants[id]}),
    })),
  };
  return stableStringify(doc) + '\n';
}

/** One line per engine event that changes state, `+12.500s <type> <subject>`.
 *  Drops and per-drop updates are counted, not listed; a `tracker_update` is
 *  listed only when its tracker's active/owner flags change. */
function eventLines(events: ReplayEvent[], origin: number): {lines: string[]; counts: Record<string, number>} {
  const lines:  string[] = [];
  const counts: Record<string, number> = {};
  const flags = new Map<string, string>();
  for (const {event, at} of events) {
    // Persistence-only, never reaches the renderer; a golden pins its effect as `rows`.
    if (event.type === 'unit_finished') continue;
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    const desc = describeEvent(event, flags);
    if (desc !== null) lines.push(`${fmtSeconds(at - origin)} ${desc}`);
  }
  return {lines, counts};
}

function trackerName(t: TrackerSnapshot): string {
  if (t.kind !== 'seasonal') return t.kind;
  return `seasonal ${t.seasonalType ?? '?'}${t.phase ? `/${t.phase}` : ''}`;
}

function trackerFlags(t: TrackerSnapshot): string {
  return `active=${t.active}${t.owner ? ' owner' : ''}`;
}

function itemCount(t: TrackerSnapshot): number {
  return Object.keys(t.drops).length;
}

function describeEvent(e: EngineEvent, flags: Map<string, string>): string | null {
  switch (e.type) {
    case 'drop':
    case 'price_update':
    case 'wealth_recorded':
    case 'unit_finished':
      return null;
    case 'tracker_update': {
      const name = trackerName(e.tracker);
      const f = trackerFlags(e.tracker);
      if (flags.get(name) === f) return null;
      flags.set(name, f);
      return `tracker_update ${name} ${f}`;
    }
    case 'tracker_started':
      flags.set(trackerName(e.tracker), trackerFlags(e.tracker));
      return `tracker_started ${trackerName(e.tracker)} ${trackerFlags(e.tracker)}`;
    case 'tracker_finished':
      flags.delete(trackerName(e.tracker));
      return `tracker_finished ${trackerName(e.tracker)} elapsed=${fmtSeconds(e.tracker.elapsed, false)} items=${itemCount(e.tracker)}`;
    case 'init_complete':        return `init_complete items=${e.itemCount}`;
    case 'new_item':             return `new_item ${e.itemId}`;
    case 'zone_change':          return `zone_change ${e.entering} ${e.from} -> ${e.to}`;
    case 'map_started':          return `map_started count=${e.mapCount}`;
    case 'map_ended':            return `map_ended elapsed=${fmtSeconds(e.elapsed, false)}`;
    case 'session_status':       return `session_status ${e.status}`;
    case 'session_saved':        return `session_saved ${e.sessionId}`;
    case 'map_material_warning': return `map_material_warning items=[${e.items.map(i => `${i.itemId}x${i.quantity}`).join(',')}]`;
    case 'loot_window_started':  return `loot_window_started ${e.seasonalType ?? '?'} for=${fmtSeconds(e.deadline - e.timestamp, false)}`;
    case 'loot_window_ended':    return `loot_window_ended ${e.seasonalType ?? '?'}`;
    case 'error':                return `error ${e.message}`;
    case 'init_started':         return 'init_started';
  }
}

function fmtSeconds(ms: number, signed = true): string {
  const s = `${(normalize(ms) / 1000).toFixed(3)}s`;
  return signed && ms >= 0 ? `+${s}` : s;
}

function normalize(n: number): number {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** JSON with sorted object keys and floats rounded to 6 dp; non-finite numbers as strings. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value), null, 2);
}

function canonical(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? normalize(value) : String(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}
