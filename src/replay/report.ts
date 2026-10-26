import type {ReplayResult, ReplayRow} from './replay';

/** A persisted `session_maps` row, as the comparison needs it. */
export interface StoredRow {
  id:             number;
  mapIndex:       number;
  startedAt:      number;
  duration:       number;
  seasonalType:   string | null;
  parentMapIndex: number | null;
  drops:          Record<string, number>;
}

export interface ItemDiff {
  itemId:   string;
  replayed: number;
  stored:   number;
}

export interface RowComparison {
  replay: ReplayRow | null;
  stored: StoredRow | null;
  diffs:  ItemDiff[];
}

export type Prices = ReadonlyMap<string, number>;

/** Rows this far apart still count as the same run. `startedAt` is derived
 *  from pause-aware elapsed, so a map frozen by an interlude drifts at its
 *  start but not its end — hence matching on whichever end is closer. */
const MATCH_TOLERANCE_MS = 5_000;

function distance(r: ReplayRow, s: StoredRow): number {
  return Math.min(Math.abs(s.startedAt - r.startedAt), Math.abs(s.startedAt + s.duration - r.endedAt));
}

/**
 * Pair replayed rows with stored rows of the same type by nearest start or end
 * time, then diff their drops. Unpaired rows on either side are reported as such.
 */
export function compareRows(replayed: ReplayRow[], stored: StoredRow[]): RowComparison[] {
  const unclaimed = new Set(stored);
  const out: RowComparison[] = [];
  for (const r of replayed) {
    let best: StoredRow | null = null;
    for (const s of unclaimed) {
      if (s.seasonalType !== r.seasonalType) continue;
      const d = distance(r, s);
      if (d <= MATCH_TOLERANCE_MS && (!best || d < distance(r, best))) best = s;
    }
    if (best) unclaimed.delete(best);
    out.push({replay: r, stored: best, diffs: diffDrops(r.drops, best?.drops ?? {})});
  }
  for (const s of unclaimed) out.push({replay: null, stored: s, diffs: diffDrops({}, s.drops)});
  return out.sort((a, b) => startOf(a) - startOf(b));
}

export function diffDrops(replayed: Record<string, number>, stored: Record<string, number>): ItemDiff[] {
  const out: ItemDiff[] = [];
  for (const id of new Set([...Object.keys(replayed), ...Object.keys(stored)])) {
    const r = replayed[id] ?? 0;
    const s = stored[id] ?? 0;
    if (r !== s) out.push({itemId: id, replayed: r, stored: s});
  }
  return out;
}

export function dropsValue(drops: Record<string, number>, prices?: Prices): number {
  if (!prices) return 0;
  let total = 0;
  for (const [id, qty] of Object.entries(drops)) total += qty * (prices.get(id) ?? 0);
  return total;
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

export function formatReport(result: ReplayResult, prices?: Prices): string {
  const lines: string[] = [];
  lines.push(`Replayed ${result.linesDelivered} lines  ${fmtTime(result.firstTs)} → ${fmtTime(result.lastTs)}`);

  lines.push('', `Anomalies (${result.anomalies.length})`);
  for (const a of result.anomalies) {
    lines.push(`  ${fmtTime(a.ts)}  line ${a.lineNo ?? '-'}  ${a.kind}: ${a.detail}`);
  }

  for (const s of result.sessions) {
    lines.push('', `Session  ended ${fmtTime(s.endedAt)}  elapsed ${fmtDuration(s.elapsed)}  ` +
      `${Object.keys(s.drops).length} items${fmtValue(dropsValue(s.drops, prices), prices)}`);
  }

  lines.push('', `Runs (${result.rows.length})`);
  for (const r of result.rows) lines.push(`  ${fmtRow(r, prices)}`);

  return lines.join('\n');
}

export function formatComparison(cmp: RowComparison[], prices?: Prices): string {
  const lines: string[] = ['Replay vs stored rows'];
  for (const c of cmp) {
    const label = c.replay ? fmtRow(c.replay, prices) : `(not replayed) ${c.stored!.seasonalType ?? 'map'} ${fmtTime(c.stored!.startedAt)}`;
    const id = c.stored ? `#${c.stored.id} m${c.stored.mapIndex}` : '(no stored row)';
    const verdict = c.diffs.length === 0 ? 'match' : `${c.diffs.length} item(s) differ`;
    lines.push(`  ${id.padEnd(14)} ${label}  — ${verdict}`);
    const sorted = [...c.diffs].sort((a, b) => Math.abs(b.replayed - b.stored) - Math.abs(a.replayed - a.stored));
    for (const d of sorted.slice(0, 8)) {
      lines.push(`      ${d.itemId.padStart(7)}  replayed ${d.replayed}  stored ${d.stored}`);
    }
    if (sorted.length > 8) lines.push(`      … ${sorted.length - 8} more`);
  }
  return lines.join('\n');
}

function fmtRow(r: ReplayRow, prices?: Prices): string {
  const type = r.seasonalType ? `${r.seasonalType}${r.phase ? `/${r.phase}` : ''}${r.overlap ? ' (in map)' : ''}` : 'map';
  return `${fmtTime(r.startedAt)}  ${type.padEnd(22)} ${fmtDuration(r.endedAt - r.startedAt).padStart(8)}  ` +
    `${Object.keys(r.drops).length} items${fmtValue(dropsValue(r.drops, prices), prices)}`;
}

function fmtValue(v: number, prices?: Prices): string {
  return prices ? `  ${v.toFixed(1)} FE` : '';
}

/** UTC (matches the game log) with local time alongside. */
export function fmtTime(ts: number | null): string {
  if (ts === null) return '-';
  const d = new Date(ts);
  const local = d.toLocaleTimeString('en-GB', {hour12: false});
  return `${d.toISOString().slice(11, 19)}Z (${local})`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function startOf(c: RowComparison): number {
  return c.replay?.startedAt ?? c.stored?.startedAt ?? 0;
}
