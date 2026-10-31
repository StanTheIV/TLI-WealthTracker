/**
 * Log replayer CLI — feeds a recorded UE_game.log through the real engine and
 * session persistence under virtual time and reports what it would have saved.
 * `bun run replay --help` lists the options.
 *
 * The app DB (`--db`) is only ever opened read-only, and only by the modes
 * that read it; the replay itself persists into an in-memory DB.
 */
import {writeFileSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';
import {parseArgs} from 'util';
import {initLogger} from '@/main/logger';
import {configureEngine} from '@/main/engine/configure-engine';
import {MIGRATIONS, runMigrations} from '@/main/db/migrations';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {SqlConn} from '@/main/db/sql-conn';
import type {FilterRule} from '@/shared/item-filter';
import {LOG_SUBPATH} from '@/shared/paths';
import {readLogFile, type SliceOptions} from '@/replay/log-source';
import {replay, type ControlOp} from '@/replay/replay';
import {compareRows, diffDrops, formatComparison, formatReport} from '@/replay/report';
import {createScrubber} from '@/replay/scrub';
import {openBunSqlite} from '@/replay/sql/bun-sqlite';

const DEFAULT_DB  = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'tli-tracker', 'tli-tracker.db');

const USAGE = `Usage: bun run replay [log] [options]

Replays a game log through the real engine and session persistence under
virtual time and prints the sessions and rows the app would have saved.

  log                       Game log. Default: <settings.torchlightPath>/${LOG_SUBPATH}

Slice (times without an offset are UTC, like the log; bounds inclusive):
  --from <time>             First log time, e.g. 2026-10-25T08:30:00Z
  --to <time>               Last log time
  --lines <a:b>             Line range, 1-based

Replay:
  --exact                   Deliver each line at its own timestamp (default: 250 ms watcher polls)
  --start, --pause, --resume, --stop <time>
                            Operator controls, repeatable (default: one start before the first line)
  --compare-session <id>    Diff the replay against a session stored in --db
  --json <file>             Write the result as JSON
  --verbose                 Engine info/debug logging

Extract (opens no DB when <log> is given):
  --extract <file>          Write the slice's raw lines to <file>
  --scrub                   With --extract: keep only lines that feed the engine (market price scrapes are
                            dropped; fixture prices come from the item table), redact Tartarus run ids;
                            a dropped first/last line becomes a bare timestamp so the replay clock is unchanged

  --db <file>               App DB for settings, items and filters, opened read-only
                            (default: ${DEFAULT_DB})
  -h, --help                Show this help`;

function parseCli() {
  try {
    return parseArgs({
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
        scrub:             {type: 'boolean', default: false},
        'compare-session': {type: 'string'},
        db:                {type: 'string', default: DEFAULT_DB},
        verbose:           {type: 'boolean', default: false},
        help:              {type: 'boolean', short: 'h', default: false},
      },
    });
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exit(2);
  }
}

const {values: args, positionals} = parseCli();
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.scrub && !args.extract) {
  console.error(`--scrub needs --extract\n\n${USAGE}`);
  process.exit(2);
}

const levels = args.verbose ? ['info', 'warn', 'error', 'debug'] : ['warn', 'error'];
const features = ['engine', 'worker', 'database', 'ipc', 'overlay', 'session', 'price', 'wealth', 'app', 'filter', 'update'];
initLogger({
  logFile:  null,
  settings: () => ({
    'logging.console': JSON.stringify({enabled: true, features, types: levels}),
    'logging.file':    JSON.stringify({enabled: false}),
  }),
});

function parseTime(raw: string): number {
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const ts = Date.parse(iso.replace(' ', 'T'));
  if (Number.isNaN(ts)) throw new Error(`Unparseable time: ${raw}`);
  return ts;
}

let appDb: SqlConn | null = null;
/** The app DB, read-only — opened on first use. */
function sourceDb(): SqlConn {
  if (!appDb) {
    appDb = openBunSqlite(args.db!, {readonly: true});
    appDb.setPragma('foreign_keys', 'ON');   // bun:sqlite defaults OFF; every app-schema conn runs with it ON
  }
  return appDb;
}

function readSettings(): Record<string, string> {
  const rows = sourceDb().prepare('SELECT key, value FROM settings').all<{key: string; value: string}>();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function resolveLogPath(): string {
  if (positionals[0]) return positionals[0];
  const torchlightPath = readSettings()['torchlightPath'];
  if (!torchlightPath) throw new Error('No log path given and settings.torchlightPath is unset');
  return join(torchlightPath, LOG_SUBPATH);
}

const logPath = resolveLogPath();
const [fromLine, toLine] = args.lines ? args.lines.split(':').map(Number) : [undefined, undefined];
const slice: SliceOptions = {
  from: args.from ? parseTime(args.from) : undefined,
  to:   args.to   ? parseTime(args.to)   : undefined,
  fromLine,
  toLine,
};

if (args.extract) await extract(args.extract);
else              await runReplay();

async function extract(outPath: string): Promise<void> {
  const scrubber = args.scrub ? createScrubber() : null;
  const out: string[] = [];
  for await (const line of readLogFile(logPath, slice)) {
    const text = scrubber ? scrubber.scrub(line) : line.text;
    if (text !== null) out.push(text);
  }
  const closing = scrubber?.finish() ?? null;
  if (closing !== null) out.push(closing);
  writeFileSync(outPath, out.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${out.length} lines to ${outPath}`);
  if (scrubber) {
    const {kept, dropped, unstamped, anchors} = scrubber.stats;
    console.log(`Scrubbed: kept ${kept}, dropped ${dropped} (${anchors} replaced by a bare time anchor)`);
    if (unstamped > 0) console.log(`Warning: ${unstamped} kept line(s) have no timestamp and inherit the previous kept line's`);
  }
}

async function runReplay(): Promise<void> {
  const settings = readSettings();
  const items = sourceDb().prepare('SELECT id, type, price FROM items').all<{id: string; type: string; price: number}>();
  const prices = new Map(items.map(i => [i.id, i.price]));
  const filter = sourceDb().prepare('SELECT rules FROM item_filters WHERE enabled = 1 ORDER BY rowid LIMIT 1').get<{rules: string}>();

  const controls: ControlOp[] = [];
  for (const op of ['start', 'pause', 'resume', 'stop'] as const) {
    for (const t of args[op] ?? []) controls.push({at: parseTime(t), op});
  }

  // The replay saves through production's persistence into a scratch DB.
  const replayDb = openBunSqlite(':memory:');
  replayDb.setPragma('foreign_keys', 'ON');   // the store's deleteSession relies on the cascade
  runMigrations(replayDb, MIGRATIONS, {backup: () => {}});

  const result = await replay({
    source:      readLogFile(logPath, slice),
    mode:        args.exact ? 'exact' : 'poll',
    controls,
    persistence: {
      store:      new SqliteSessionStore(replayDb),
      readPrices: ids => {
        const out: Record<string, number> = {};
        for (const id of ids) {
          const price = prices.get(id);
          if (price !== undefined) out[id] = price;
        }
        return out;
      },
    },
    configure: (engine) => configureEngine(engine, {
      items,
      filterRules: filter ? JSON.parse(filter.rules) as FilterRule[] : null,
      settings,
    }),
  });

  console.log(formatReport(result, prices));

  const sessionId = args['compare-session'];
  if (sessionId) {
    const stored = new SqliteSessionStore(sourceDb());
    const storedSession = stored.getSession(sessionId);
    if (!storedSession) {
      console.log(`\nSession ${sessionId} not found in ${args.db}`);
    } else {
      console.log('\n' + formatComparison(compareRows(result.sessions.flatMap(s => s.rows), stored.getRows(sessionId)), prices));

      const replayedSession = result.sessions.filter(s => s.session !== null).at(-1)?.session;
      if (replayedSession) {
        const diffs = diffDrops(replayedSession.drops, storedSession.drops);
        console.log(`\nSession totals: ${diffs.length === 0 ? 'match' : `${diffs.length} item(s) differ`}`);
        for (const d of diffs.slice(0, 15)) console.log(`  ${d.itemId.padStart(7)}  replayed ${d.replayed}  stored ${d.stored}`);
      }
    }
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({
      log: logPath, slice, mode: args.exact ? 'exact' : 'poll', controls,
      anomalies: result.anomalies,
      sessions:  result.sessions,
      drops:     result.events.filter(e => e.event.type === 'drop').map(e => ({...e.event, lineNo: e.lineNo})),
      finalInventory: Object.fromEntries(result.finalInventory),
    }, null, 2));
    console.log(`\nWrote ${args.json}`);
  }
}
