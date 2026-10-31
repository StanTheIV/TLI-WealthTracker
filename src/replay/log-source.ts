import {createReadStream} from 'fs';

/** One game-log line, with the log time it was written at. */
export interface LogLine {
  /** 1-based line number in the source file. */
  lineNo: number;
  /** Epoch ms (UTC) from the line's prefix, or inherited from the previous line. */
  ts:     number;
  text:   string;
}

/** Restricts a replay to part of a log. Bounds are inclusive. */
export interface SliceOptions {
  from?:     number;
  to?:       number;
  fromLine?: number;
  toLine?:   number;
}

const RE_TS = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/;

/** The game stamps every line `[YYYY.MM.DD-HH.mm.ss:mmm]` in UTC. */
export function parseLogTimestamp(line: string): number | null {
  const m = RE_TS.exec(line);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

/** The inverse of `parseLogTimestamp`: the `[YYYY.MM.DD-HH.mm.ss:mmm]` prefix for an epoch-ms UTC time. */
export function formatLogTimestamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `[${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}:${p(d.getUTCMilliseconds(), 3)}]`;
}

/**
 * Turns raw numbered lines into timestamped LogLines, mirroring what the
 * watcher hands the dispatcher: `\r` stripped, blank lines dropped. A line
 * with no prefix inherits the previous timestamp; lines before the first
 * timestamp can't be placed in time and are skipped.
 *
 * The log is append-only and therefore time-ordered, so iteration stops at
 * the first line past the slice instead of reading a 600 MB file to the end.
 */
function sliceFilter(opts: SliceOptions) {
  let lastTs: number | null = null;
  return (lineNo: number, raw: string): LogLine | 'skip' | 'done' => {
    if (opts.toLine !== undefined && lineNo > opts.toLine) return 'done';
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    lastTs = parseLogTimestamp(text) ?? lastTs;
    if (lastTs === null) return 'skip';
    if (opts.to !== undefined && lastTs > opts.to) return 'done';
    if (opts.fromLine !== undefined && lineNo < opts.fromLine) return 'skip';
    if (opts.from !== undefined && lastTs < opts.from) return 'skip';
    if (text.trim().length === 0) return 'skip';
    return {lineNo, ts: lastTs, text};
  };
}

/**
 * Stream a (possibly huge) log file from disk. Splits on `\n` only, like the
 * watcher — `readline` would also break on a lone `\r`, which the game log
 * contains, and line numbers would drift from what grep and editors show.
 */
export async function* readLogFile(path: string, opts: SliceOptions = {}): AsyncGenerator<LogLine> {
  const filter = sliceFilter(opts);
  const stream = createReadStream(path, {encoding: 'utf8'});
  let lineNo = 0;
  let rest = '';
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const parts = (rest + chunk).split('\n');
      rest = parts.pop()!;
      for (const raw of parts) {
        const out = filter(++lineNo, raw);
        if (out === 'done') return;
        if (out !== 'skip') yield out;
      }
    }
    if (rest.length > 0) {
      const out = filter(++lineNo, rest);
      if (out !== 'done' && out !== 'skip') yield out;
    }
  } finally {
    stream.destroy();
  }
}

/** In-memory variant — fixtures and tests. `text` may hold the whole file. */
export function* readLogText(text: string, opts: SliceOptions = {}): Generator<LogLine> {
  const filter = sliceFilter(opts);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const out = filter(i + 1, lines[i]);
    if (out === 'done') return;
    if (out !== 'skip') yield out;
  }
}
