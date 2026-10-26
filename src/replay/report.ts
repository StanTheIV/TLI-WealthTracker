import type {DbSessionMap} from '@/shared/contracts/db';
import type {ReplayResult, ReplayedSession} from './replay';

export interface ItemDiff {
  itemId:   string;
  replayed: number;
  stored:   number;
}

/** Row fields compared beyond the item maps — the ones row identity rests on. */
const COMPARED_FIELDS = ['mapIndex', 'parentMapIndex', 'phase'] as const;
type ComparedField = typeof COMPARED_FIELDS[number];

export interface FieldDiff {
  field:    ComparedField;
  replayed: DbSessionMap[ComparedField];
  stored:   DbSessionMap[ComparedField];
}

export interface RowComparison {
  replay: DbSessionMap | null;
  stored: DbSessionMap | null;
  drops:  ItemDiff[];
  spent:  ItemDiff[];
  /** Empty for an unpaired row — there is nothing to compare against. */
  fields: FieldDiff[];
}

export type Prices = ReadonlyMap<string, number>;

/** Rows this far apart still count as the same run. `startedAt` is derived
 *  from pause-aware elapsed, so a map frozen by an interlude drifts at its
 *  start but not its end — hence matching on whichever end is closer. */
const MATCH_TOLERANCE_MS = 5_000;

const endOf = (r: DbSessionMap): number => r.startedAt + r.duration;

function distance(r: DbSessionMap, s: DbSessionMap): number {
  return Math.min(Math.abs(s.startedAt - r.startedAt), Math.abs(endOf(s) - endOf(r)));
}

/**
 * Pair replayed rows with stored rows of the same type by nearest start or end
 * time, then diff their drops, spent and identity fields. Unpaired rows on
 * either side are reported as such.
 */
export function compareRows(replayed: DbSessionMap[], stored: DbSessionMap[]): RowComparison[] {
  const unclaimed = new Set(stored);
  const out: RowComparison[] = [];
  for (const r of replayed) {
    let best: DbSessionMap | null = null;
    for (const s of unclaimed) {
      if (s.seasonalType !== r.seasonalType) continue;
      const d = distance(r, s);
      if (d <= MATCH_TOLERANCE_MS && (!best || d < distance(r, best))) best = s;
    }
    if (best) unclaimed.delete(best);
    out.push({
      replay: r,
      stored: best,
      drops:  diffDrops(r.drops, best?.drops ?? {}),
      spent:  diffDrops(r.spent, best?.spent ?? {}),
      fields: best ? diffFields(r, best) : [],
    });
  }
  for (const s of unclaimed) {
    out.push({replay: null, stored: s, drops: diffDrops({}, s.drops), spent: diffDrops({}, s.spent), fields: []});
  }
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

function diffFields(r: DbSessionMap, s: DbSessionMap): FieldDiff[] {
  return COMPARED_FIELDS.filter(f => r[f] !== s[f]).map(f => ({field: f, replayed: r[f], stored: s[f]}));
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

  for (const s of result.sessions) lines.push('', ...fmtSession(s, prices));

  return lines.join('\n');
}

export function formatComparison(cmp: RowComparison[], prices?: Prices): string {
  const lines: string[] = ['Replay vs stored rows'];
  for (const c of cmp) {
    const label = c.replay ? fmtRow(c.replay, prices) : `(not replayed) ${fmtRow(c.stored!, prices)}`;
    const id = c.stored ? `stored m${c.stored.mapIndex}` : '(no stored row)';
    lines.push(`  ${id.padEnd(15)} ${label}  — ${verdict(c)}`);
    for (const f of c.fields) {
      lines.push(`      ${f.field.padEnd(14)}  replayed ${f.replayed ?? '-'}  stored ${f.stored ?? '-'}`);
    }
    pushItemDiffs(lines, 'drop ', c.drops);
    pushItemDiffs(lines, 'spent', c.spent);
  }
  return lines.join('\n');
}

function verdict(c: RowComparison): string {
  const parts: string[] = [];
  if (c.fields.length > 0) parts.push(c.fields.map(f => f.field).join(', '));
  if (c.drops.length > 0)  parts.push(`${c.drops.length} drop item(s)`);
  if (c.spent.length > 0)  parts.push(`${c.spent.length} spent item(s)`);
  return parts.length === 0 ? 'match' : `differ: ${parts.join('; ')}`;
}

function pushItemDiffs(lines: string[], label: string, diffs: ItemDiff[]): void {
  const sorted = [...diffs].sort((a, b) => Math.abs(b.replayed - b.stored) - Math.abs(a.replayed - a.stored));
  for (const d of sorted.slice(0, 8)) {
    lines.push(`      ${label} ${d.itemId.padStart(7)}  replayed ${d.replayed}  stored ${d.stored}`);
  }
  if (sorted.length > 8) lines.push(`      ${label} … ${sorted.length - 8} more`);
}

function fmtSession(s: ReplayedSession, prices?: Prices): string[] {
  if (!s.session) return [`Session ${s.id}  not saved`];
  const {session} = s;
  const lines = [
    `Session ${s.id}  ended ${fmtTime(Date.parse(session.savedAt))}  elapsed ${fmtDuration(session.totalTime * 1000)}  ` +
    `${session.mapCount} maps  ${Object.keys(session.drops).length} items${fmtValue(dropsValue(session.drops, prices), prices)}`,
    `  Rows (${s.rows.length})`,
  ];
  for (const r of s.rows) lines.push(`    ${fmtRow(r, prices)}`);
  return lines;
}

function fmtRow(r: DbSessionMap, prices?: Prices): string {
  const overlap = r.parentMapIndex !== null;
  const type = r.seasonalType ? `${r.seasonalType}${r.phase ? `/${r.phase}` : ''}${overlap ? ' (in map)' : ''}` : 'map';
  const index = `m${r.mapIndex}`;
  const spent = Object.keys(r.spent).length > 0
    ? `  spent ${Object.keys(r.spent).length} items${fmtValue(dropsValue(r.spent, prices), prices)}`
    : '';
  return `${fmtTime(r.startedAt)}  ${index.padEnd(5)} ${type.padEnd(22)} ${fmtDuration(r.duration).padStart(8)}  ` +
    `${Object.keys(r.drops).length} items${fmtValue(dropsValue(r.drops, prices), prices)}${spent}`;
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
