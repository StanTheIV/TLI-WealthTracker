import type {Engine} from '@/main/engine/engine';
import {createEngine} from '@/main/engine/create-engine';
import {SessionPersistence, type SessionPersistenceDeps} from '@/main/session-persistence';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
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
  /** Where each run is saved — production's SessionPersistence over any
   *  store (in-memory bun:sqlite in the CLI, node:sqlite in tests). */
  persistence: SessionPersistenceDeps;
  /** Id — and name — of the n-th started session (1-based). Default `replay-<n>`. */
  sessionIds?: (n: number) => string;
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

/** One started run, read back from the store after the replay. */
export interface ReplayedSession {
  id:      string;
  /** Null when nothing was saved: discarded (too short, no drops) or never
   *  finished (`stopAtEnd: false`). */
  session: DbSession | null;
  rows:    DbSessionMap[];
}

export interface ReplayResult {
  events:         ReplayEvent[];
  /** Every started run, in start order. */
  sessions:       ReplayedSession[];
  anomalies:      Anomaly[];
  finalInventory: Map<number, number>;
  linesDelivered: number;
  firstTs:        number | null;
  lastTs:         number | null;
}

const DEFAULT_POLL_MS   = 250;
const DEFAULT_SETTLE_MS = 60_000;

/**
 * Feed a recorded game log through the real dispatcher → engine →
 * SessionPersistence pipeline under virtual time. Production code paths only:
 * the processor chain and handler chain are the shared factories, every
 * debounce or loot window fires in log time, and a run saves exactly what the
 * app would have written to its DB.
 */
export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const mode     = opts.mode ?? 'poll';
  const pollMs   = opts.pollMs ?? DEFAULT_POLL_MS;
  const idOf     = opts.sessionIds ?? ((n: number) => `replay-${n}`);
  const dispatcher = createDispatcher();

  const events:     ReplayEvent[] = [];
  const sessionIds: string[]      = [];

  // Casts, not annotations: closures below reassign them, and TS would
  // otherwise narrow them to `null` for the rest of the function.
  let engine      = null as Engine | null;
  let persistence = null as SessionPersistence | null;
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
    // Synchronous, against the live engine — as TrackingService persists, so
    // overlap detection reads the registry mid-transition.
    if (engine && persistence) persistence.onTrackerFinished(event, engine);
  };

  const controls = [...(opts.controls ?? [])].sort((a, b) => a.at - b.at);
  const autoStart = !controls.some(c => c.op === 'start');

  const advance = (ts: number): void => {
    if (ts <= now) return;
    clock!.advanceTo(ts);
    now = ts;
    monitor.afterAdvance(now, lastLineNo);
  };

  /** As TrackingService.stop: the session's finish reaches the run's own
   *  persistence, then whatever that left buffered is dropped. */
  const stopRun = (): void => {
    try {
      engine?.stop(); // emits the session tracker_finished → auto-save
    } finally {
      engine = null;
      persistence?.discard();
      persistence = null;
    }
  };

  const apply = (op: ControlOp['op']): void => {
    if (op === 'start') {
      // Production stops the old run first, then builds a fresh engine and persistence.
      stopRun();
      const id = idOf(sessionIds.length + 1);
      sessionIds.push(id);
      // Always named: the generated name is local time (TZ-dependent).
      persistence = new SessionPersistence({sessionId: id, sessionName: id, isOverride: false}, opts.persistence);
      engine = createEngine(emit);
      engine.start();
      opts.configure?.(engine);
    } else if (op === 'pause')  engine?.pause();
    else if (op === 'resume')   engine?.resume();
    else if (op === 'stop')     stopRun();
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
        // As TrackingService._onWorkerEvent: prices go to the item table (none here), never to the engine.
        if (raw.type !== 'price_update') engine?.onRawEvent(raw);
      }
    }
  };

  const readSessions = (): ReplayedSession[] => sessionIds.map(id => ({
    id,
    session: opts.persistence.store.getSession(id),
    rows:    opts.persistence.store.getRows(id),
  }));

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
      return {events, sessions: [], anomalies: [], finalInventory: new Map(), linesDelivered: 0, firstTs, lastTs};
    }
    if (batch.length > 0) deliver(batchAt, batch);

    const end = now + (opts.settleMs ?? DEFAULT_SETTLE_MS);
    runControlsUpTo(end);
    advance(end);
    const finalInventory = engine?.getInventory() ?? new Map<number, number>();
    monitor.finish(now, lastLineNo);
    if (opts.stopAtEnd ?? true) apply('stop');

    return {events, sessions: readSessions(), anomalies: monitor.anomalies, finalInventory, linesDelivered, firstTs, lastTs};
  } finally {
    clock?.dispose();
  }
}

/** The watcher's next poll at or after `ts`. A poll grid anchored at the first line. */
function pollBoundary(origin: number, ts: number, pollMs: number): number {
  return origin + Math.ceil((ts - origin) / pollMs) * pollMs;
}
