import {utilityProcess} from 'electron';
import type {UtilityProcess} from 'electron';
import {join} from 'path';
import type {RawEvent} from '@/worker/processors/types';
import {log} from './logger';

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

    this._process = utilityProcess.fork(join(__dirname, 'index.js'));
    this._process.on('message', (raw: RawEvent) => this._handleMessage(raw));
    this._process.on('exit', () => {
      log.warn('worker', 'Worker exited');
      this._process = null;
    });

    this._process.postMessage({type: 'start', logPath});
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

  private _handleMessage(raw: RawEvent): void {
    if (raw.type === 'worker_log') {
      log[raw.logType]('worker', raw.message);
      return;
    }
    if (raw.type === 'reader_ready') {
      log.debug('worker', 'Reader ready');
      return;
    }
    if (raw.type === 'reader_error') {
      log.error('worker', `Reader error: ${raw.message}`);
      return;
    }
    this._onEvent(raw);
  }
}
