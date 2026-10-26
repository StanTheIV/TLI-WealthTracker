import type {Engine} from '@/main/engine/engine';
import {createEngine} from '@/main/engine/create-engine';
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import {createDispatcher} from '@/worker/create-dispatcher';
import type {LogLine} from './log-source';
import {installReplayClock, type ReplayClock} from './clock';
import {InvariantMonitor, type Anomaly} from './invariants';

/**
 * - `poll`: production-faithful. The watcher polls every 250 ms and hands the
 *   engine everything written since, back-to-back at one instant.
 * - `exact`: every line is delivered at its own log timestamp.
 */
export type ReplayMode = 'poll' | 'exact';

/** Operator actions that never appear in the game log. */
export interface ControlOp {
  at: number;
  op: 'start' | 'pause' | 'resume' | 'stop';
}

export interface ReplayOptions {
  source:    AsyncIterable<LogLine> | Iterable<LogLine>;
  mode?:     ReplayMode;
  pollMs?:   number;
  /** Defaults to a single `start` just before the first line. */
  controls?: ControlOp[];
  /** Runs after every `start()`, as production's TrackingService configures settings. */
  configure?: (engine: Engine) => void;
  /** Log time to run on after the last line so pending windows close. Default 60 s. */
  settleMs?: number;
  /** Stop the engine at the end (emits the session's tracker_finished). Default true. */
  stopAtEnd?: boolean;
}

export interface ReplayEvent {
  event:  EngineEvent;
  /** Virtual time the event was emitted at. */
  at:     number;
  /** Last log line delivered before the event (timer-fired events included). */
  lineNo: number | null;
}

/** A finished map / seasonal tracker, shaped like a `session_maps` row. */
export interface ReplayRow {
  kind:         'map' | 'seasonal';
  seasonalType: TrackerSnapshot['seasonalType'] | null;
  phase:        TrackerSnapshot['phase'] | null;
  /** Seasonal that ran while a map was live — persisted with `parent_map_index`. */
  overlap:      boolean;
  /** Same derivation as SessionPersistence: finish time minus tracked elapsed. */
  startedAt:    number;
  endedAt:      number;
  drops:        Record<string, number>;
}

export interface ReplaySession {
  endedAt:       number;
  elapsed:       number;
  drops:         Record<string, number>;
  dropsBySource: TrackerSnapshot['dropsBySource'];
}

export interface ReplayResult {
  events:         ReplayEvent[];
  rows:           ReplayRow[];
  sessions:       ReplaySession[];
  anomalies:      Anomaly[];
  finalInventory: Map<number, number>;
  linesDelivered: number;
  firstTs:        number | null;
  lastTs:         number | null;
}

const DEFAULT_POLL_MS   = 250;
const DEFAULT_SETTLE_MS = 60_000;

/**
 * Feed a recorded game log through the real dispatcher → engine pipeline
 * under virtual time. Production code paths only: the processor chain and
 * handler chain are the shared factories, and every debounce or loot window
 * fires in log time.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const mode     = opts.mode ?? 'poll';
  const pollMs   = opts.pollMs ?? DEFAULT_POLL_MS;
  const dispatcher = createDispatcher();

  const events:   ReplayEvent[]   = [];
  const rows:     ReplayRow[]     = [];
  const sessions: ReplaySession[] = [];

  // Cast, not annotation: closures below reassign it, and TS would otherwise
  // narrow it to `null` for the rest of the function.
  let engine = null as Engine | null;
  let clock:  ReplayClock | null = null;
  let now = 0;
  let lastLineNo: number | null = null;
  let linesDelivered = 0;
  let firstTs: number | null = null;
  let lastTs:  number | null = null;

  const monitor = new InvariantMonitor(() => engine);

  const emit = (event: EngineEvent): void => {
    events.push({event, at: Date.now(), lineNo: lastLineNo});
    monitor.onEngineEvent(event, lastLineNo);
    if (event.type !== 'tracker_finished') return;
    const t = event.tracker;
    if (t.kind === 'session') {
      sessions.push({endedAt: event.timestamp, elapsed: t.elapsed, drops: stringKeys(t.drops), dropsBySource: t.dropsBySource});
      return;
    }
    rows.push({
      kind:         t.kind,
      seasonalType: t.seasonalType ?? null,
      phase:        t.phase ?? null,
      // Emit is synchronous, so this reads the registry mid-transition — the
      // same moment SessionPersistence asks the same question.
      overlap:      t.kind === 'seasonal' && engine !== null && engine.hasActiveMapTracker(),
      startedAt:    event.timestamp - t.elapsed,
      endedAt:      event.timestamp,
      drops:        stringKeys(t.drops),
    });
  };

  const controls = [...(opts.controls ?? [])].sort((a, b) => a.at - b.at);
  const autoStart = !controls.some(c => c.op === 'start');

  const advance = (ts: number): void => {
    if (ts <= now) return;
    clock!.advanceTo(ts);
    now = ts;
    monitor.afterAdvance(now, lastLineNo);
  };

  const apply = (op: ControlOp['op']): void => {
    if (op === 'start') {
      // Production builds a fresh engine per start and stops the old one first.
      engine?.stop();
      engine = createEngine(emit);
      engine.start();
      opts.configure?.(engine);
    } else if (op === 'pause')  engine?.pause();
    else if (op === 'resume')   engine?.resume();
    else if (op === 'stop')   { engine?.stop(); engine = null; }
  };

  const runControlsUpTo = (ts: number): void => {
    while (controls.length > 0 && controls[0].at <= ts) {
      const c = controls.shift()!;
      advance(c.at);
      apply(c.op);
    }
  };

  const deliver = (at: number, batch: LogLine[]): void => {
    runControlsUpTo(at);
    advance(at);
    for (const line of batch) {
      lastLineNo = line.lineNo;
      linesDelivered++;
      for (const raw of dispatcher.dispatch(line.text)) {
        monitor.onRawEvent(raw, line.ts, line.lineNo);
        engine?.onRawEvent(raw);
      }
    }
  };

  try {
    let batch: LogLine[] = [];
    let batchAt = 0;

    for await (const line of opts.source) {
      if (clock === null) {
        firstTs = line.ts;
        // Start one tick early so `start` precedes the first line, as it would live.
        now = line.ts - 1;
        clock = installReplayClock(now);
        if (autoStart) apply('start');
      }
      lastTs = line.ts;

      const at = mode === 'exact' ? line.ts : pollBoundary(firstTs!, line.ts, pollMs);
      if (batch.length > 0 && at !== batchAt) {
        deliver(batchAt, batch);
        batch = [];
      }
      batchAt = at;
      batch.push(line);
    }
    if (clock === null) {
      return {events, rows, sessions, anomalies: [], finalInventory: new Map(), linesDelivered: 0, firstTs, lastTs};
    }
    if (batch.length > 0) deliver(batchAt, batch);

    const end = now + (opts.settleMs ?? DEFAULT_SETTLE_MS);
    runControlsUpTo(end);
    advance(end);
    const finalInventory = engine?.getInventory() ?? new Map<number, number>();
    monitor.finish(now, lastLineNo);
    if (opts.stopAtEnd ?? true) apply('stop');

    return {events, rows, sessions, anomalies: monitor.anomalies, finalInventory, linesDelivered, firstTs, lastTs};
  } finally {
    clock?.dispose();
  }
}

/** The watcher's next poll at or after `ts`. A poll grid anchored at the first line. */
function pollBoundary(origin: number, ts: number, pollMs: number): number {
  return origin + Math.ceil((ts - origin) / pollMs) * pollMs;
}

function stringKeys(drops: Record<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(drops)) out[String(k)] = v;
  return out;
}
