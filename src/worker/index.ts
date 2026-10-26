/**
 * Worker — Utility Process entry point.
 *
 * Tails the TLI game log, dispatches lines to registered processors,
 * and posts raw events to the main process via process.parentPort.
 */

import {Watcher} from './watcher';
import {createDispatcher} from './create-dispatcher';
import type {RawEvent} from './processors/types';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const dispatcher = createDispatcher();

const watcher = new Watcher(
  (lines) => {
    for (const line of lines) {
      const events = dispatcher.dispatch(line);
      for (const event of events) {
        post(event);
      }
    }
  },
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
