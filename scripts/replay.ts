/**
 * Log replayer CLI — feeds a recorded UE_game.log through the real engine
 * under virtual time and reports what it would have tracked.
 *
 *   bun run replay [log] --from 2026-10-25T08:30:00Z --to 2026-10-25T11:15:00Z
 *   bun run replay --lines 1944270:1944890 --exact
 *   bun run replay --from … --to … --compare-session <id> --json out.json
 *   bun run replay --lines a:b --extract fixture.txt
 *
 * The log defaults to the one the app tracks (settings.torchlightPath). Times
 * without an offset are UTC, like the log itself. The DB is opened read-only.
 */
import {Database} from 'bun:sqlite';
import {writeFileSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';
import {parseArgs} from 'util';
import {initLogger} from '@/main/logger';
import {configureEngine} from '@/main/engine/configure-engine';
import type {FilterRule} from '@/shared/item-filter';
import {LOG_SUBPATH} from '@/shared/paths';
import {readLogFile} from '@/replay/log-source';
import {replay, type ControlOp} from '@/replay/replay';
import {compareRows, diffDrops, formatComparison, formatReport, type StoredRow} from '@/replay/report';

const DEFAULT_DB  = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'tli-tracker', 'tli-tracker.db');

const {values: args, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    from:              {type: 'string'},
    to:                {type: 'string'},
    lines:             {type: 'string'},
    exact:             {type: 'boolean', default: false},
    start:             {type: 'string', multiple: true},
    pause:             {type: 'string', multiple: true},
    resume:            {type: 'string', multiple: true},
    stop:              {type: 'string', multiple: true},
    json:              {type: 'string'},
    extract:           {type: 'string'},
    'compare-session': {type: 'string'},
    db:                {type: 'string', default: DEFAULT_DB},
    verbose:           {type: 'boolean', default: false},
  },
});

function parseTime(raw: string): number {
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const ts = Date.parse(iso.replace(' ', 'T'));
  if (Number.isNaN(ts)) throw new Error(`Unparseable time: ${raw}`);
  return ts;
}

const db = new Database(args.db!, {readonly: true});
const settings = Object.fromEntries(
  (db.query('SELECT key, value FROM settings').all() as {key: string; value: string}[]).map(r => [r.key, r.value]),
);
const items = db.query('SELECT id, type, price FROM items').all() as {id: string; type: string; price: number}[];
const prices = new Map(items.map(i => [i.id, i.price]));
const filter = db.query('SELECT rules FROM item_filters WHERE enabled = 1 ORDER BY rowid LIMIT 1').get() as {rules: string} | null;

const logPath = positionals[0] ?? (settings['torchlightPath'] ? join(settings['torchlightPath'], LOG_SUBPATH) : null);
if (!logPath) throw new Error('No log path given and settings.torchlightPath is unset');

const [fromLine, toLine] = args.lines ? args.lines.split(':').map(Number) : [undefined, undefined];
const slice = {
  from: args.from ? parseTime(args.from) : undefined,
  to:   args.to   ? parseTime(args.to)   : undefined,
  fromLine,
  toLine,
};

if (args.extract) {
  const out: string[] = [];
  for await (const line of readLogFile(logPath, slice)) out.push(line.text);
  writeFileSync(args.extract, out.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${out.length} lines to ${args.extract}`);
  process.exit(0);
}

const levels = args.verbose ? ['info', 'warn', 'error', 'debug'] : ['warn', 'error'];
const features = ['engine', 'worker', 'database', 'ipc', 'overlay', 'session', 'price', 'wealth', 'app', 'filter', 'update'];
initLogger(() => ({
  'logging.console': JSON.stringify({enabled: true, features, types: levels}),
  'logging.file':    JSON.stringify({enabled: false}),
}));

const controls: ControlOp[] = [];
for (const op of ['start', 'pause', 'resume', 'stop'] as const) {
  for (const t of args[op] ?? []) controls.push({at: parseTime(t), op});
}

const result = await replay({
  source:    readLogFile(logPath, slice),
  mode:      args.exact ? 'exact' : 'poll',
  controls,
  configure: (engine) => configureEngine(engine, {
    items,
    filterRules: filter ? JSON.parse(filter.rules) as FilterRule[] : null,
    settings,
  }),
});

console.log(formatReport(result, prices));

const sessionId = args['compare-session'];
if (sessionId) {
  const stored = (db.query(
    'SELECT id, map_index, started_at, duration, seasonal_type, parent_map_index, drops FROM session_maps WHERE session_id = ? ORDER BY started_at',
  ).all(sessionId) as {id: number; map_index: number; started_at: number; duration: number; seasonal_type: string | null; parent_map_index: number | null; drops: string}[])
    .map((r): StoredRow => ({
      id: r.id, mapIndex: r.map_index, startedAt: r.started_at, duration: r.duration,
      seasonalType: r.seasonal_type, parentMapIndex: r.parent_map_index, drops: JSON.parse(r.drops),
    }));
  console.log('\n' + formatComparison(compareRows(result.rows, stored), prices));

  const session = db.query('SELECT drops FROM sessions WHERE id = ?').get(sessionId) as {drops: string} | null;
  const replayedSession = result.sessions.at(-1);
  if (session && replayedSession) {
    const diffs = diffDrops(replayedSession.drops, JSON.parse(session.drops));
    console.log(`\nSession totals: ${diffs.length === 0 ? 'match' : `${diffs.length} item(s) differ`}`);
    for (const d of diffs.slice(0, 15)) console.log(`  ${d.itemId.padStart(7)}  replayed ${d.replayed}  stored ${d.stored}`);
  }
}

if (args.json) {
  writeFileSync(args.json, JSON.stringify({
    log: logPath, slice, mode: args.exact ? 'exact' : 'poll', controls,
    anomalies: result.anomalies,
    sessions:  result.sessions,
    rows:      result.rows,
    drops:     result.events.filter(e => e.event.type === 'drop').map(e => ({...e.event, lineNo: e.lineNo})),
    finalInventory: Object.fromEntries(result.finalInventory),
  }, null, 2));
  console.log(`\nWrote ${args.json}`);
}
