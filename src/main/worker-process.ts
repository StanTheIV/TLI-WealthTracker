import {utilityProcess} from 'electron';
import type {UtilityProcess} from 'electron';
import {join} from 'path';
import type {RawEvent} from '@/worker/processors/types';
import {log} from './logger';
import {parseWorkerMessage} from './worker-message';

/** A V8 fatal-error report is a whole diagnostic report — keep its head. */
const MAX_REPORT_LENGTH = 4_096;

/**
 * Owns the log-reader utility process: forks it, listens for messages,
 * absorbs the worker-internal events (worker_log, reader_ready, reader_error)
 * locally, and forwards every other RawEvent to a single callback.
 *
 * The worker survives engine.stop()/start() cycles — it tails the game log
 * file independently. Only stopped explicitly on app shutdown.
 */
export class WorkerProcess {
  private _process: UtilityProcess | null = null;
  private readonly _onEvent: (event: RawEvent) => void;

  /**
   * @param onEvent Called for every non-worker-internal RawEvent. Worker-only
   *   events (worker_log, reader_ready, reader_error) are absorbed and logged
   *   internally, never bubbled.
   */
  constructor(onEvent: (event: RawEvent) => void) {
    this._onEvent = onEvent;
  }

  /** Idempotent — a second call while running is a no-op. */
  start(logPath: string): void {
    if (this._process) return;

    const child = utilityProcess.fork(join(__dirname, 'index.js'));
    this._process = child;
    child.on('message', (raw: unknown) => this._handleMessage(raw));
    child.on('exit', (code) => this._handleExit(child, code));
    // V8 fatal error: the child terminates, `exit` follows.
    child.on('error', (type, location, report) => {
      const head = report.length > MAX_REPORT_LENGTH ? `${report.slice(0, MAX_REPORT_LENGTH)}… [truncated]` : report;
      log.error('worker', `Worker fatal error ${type} at ${location}\n${head}`);
    });

    child.postMessage({type: 'start', logPath});
    log.info('worker', `Worker started, tailing: ${logPath}`);
  }

  /** Safe to call when not running. */
  stop(): void {
    if (this._process) {
      log.info('worker', 'Worker stopped');
      this._process.kill();
      this._process = null;
    }
  }

  /** `_process` changes only here and in stop(), so an exiting child that is
   *  no longer `_process` is one stop() killed: expected, and it must not
   *  clear a newer child started since. */
  private _handleExit(child: UtilityProcess, code: number): void {
    if (child !== this._process) {
      log.info('worker', `Worker exited after stop (code ${code})`);
      return;
    }
    log.warn('worker', `Worker exited unexpectedly (code ${code})`);
    this._process = null;
  }

  private _handleMessage(raw: unknown): void {
    const event = parseWorkerMessage(raw);
    if (!event) {
      log.warn('worker', `Dropped a malformed worker message (${describeShape(raw)})`);
      return;
    }
    if (event.type === 'worker_log') {
      log[event.logType]('worker', event.message);
      return;
    }
    if (event.type === 'reader_ready') {
      log.debug('worker', 'Reader ready');
      return;
    }
    if (event.type === 'reader_error') {
      log.error('worker', `Reader error: ${event.message}`);
      return;
    }
    this._onEvent(event);
  }
}

/** What a rejected message was, without stringifying the value itself. */
function describeShape(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'an array';
  if (typeof raw !== 'object') return typeof raw;
  const type = (raw as Record<string, unknown>).type;
  return typeof type === 'string' ? `type ${JSON.stringify(type.slice(0, 64))}` : `type of ${typeof type}`;
}
