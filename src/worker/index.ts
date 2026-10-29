/**
 * Worker — Utility Process entry point.
 *
 * Tails the TLI game log, dispatches lines to registered processors,
 * and posts raw events to the main process via process.parentPort.
 */

import {Watcher} from './watcher';
import {createDispatcher} from './create-dispatcher';
import {dispatchLines} from './dispatch-lines';
import type {RawEvent} from './processors/types';
import {describeError} from '@/shared/describe-error';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const dispatcher = createDispatcher();

const watcher = new Watcher(
  (lines) => dispatchLines(dispatcher, lines, post, message => workerLog('error', message)),
  (message) => {
    post({type: 'reader_error', message});
  },
);

// ---------------------------------------------------------------------------
// Communication with main process
// ---------------------------------------------------------------------------

function post(event: RawEvent): void {
  process.parentPort.postMessage(event);
}

function workerLog(logType: 'info' | 'warn' | 'error' | 'debug', message: string): void {
  post({type: 'worker_log', logType, message});
}

process.parentPort.on('message', (msg: {data: {type: string; logPath: string}}) => {
  if (msg.data.type === 'start') {
    const ok = watcher.start(msg.data.logPath);
    if (ok) {
      workerLog('info', 'Watcher started');
      post({type: 'reader_ready'});
    } else {
      workerLog('error', 'Watcher start failed');
    }
  }
});

// Anything that still escapes (a watcher callback, the port itself): say why
// while the port may still work, then exit — main logs the exit code. Not
// restarted: the worker is not supervised. The exit waits a moment because
// Electron does not document that a posted message is flushed before exit.
const EXIT_GRACE_MS = 100;
process.on('uncaughtException', (err) => {
  try {
    workerLog('error', `Uncaught exception, exiting: ${describeError(err)}`);
  } catch {
    // The port is what failed; the exit code is all main gets.
  }
  setTimeout(() => process.exit(1), EXIT_GRACE_MS);
});
