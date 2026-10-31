/**
 * Renderer → main log. `reportError` keeps the console output and sends the
 * error, formatted with describeError, over `logging.report` (main names the
 * window and rate-limits). It never throws: it runs inside error handlers.
 */
import {describeError} from '@/shared/describe-error';

export function reportError(tag: string, err: unknown): void {
  try {
    console.error(tag, err);
  } catch { /* console unavailable — still try the log */ }
  try {
    window.electronAPI.logging.report(tag, describeError(err));
  } catch { /* no bridge (or IPC failed): nowhere else to send it */ }
}

const installed = new WeakSet<object>();

/** Errors nothing else catches (event handlers, timers, rejected promises) — once per window. */
export function installWindowErrorReporting(target: Pick<Window, 'addEventListener'> = window): void {
  if (installed.has(target)) return;
  installed.add(target);
  target.addEventListener('error', (e: ErrorEvent) => reportError('window error', e.error ?? e.message));
  target.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => reportError('unhandled rejection', e.reason));
}
