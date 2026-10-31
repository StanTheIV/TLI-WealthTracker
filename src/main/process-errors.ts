import type {Logger} from './logger';
import {describeError, describeErrorBrief} from '@/shared/describe-error';

export const ERROR_BOX_TITLE = 'TLI Tracker — unexpected error';

/** An error box's body: the message, then where the full details are logged ('' before the logger is up). */
export function errorBoxContent(message: string, logPath: string): string {
  return logPath ? `${message}\n\nDetails are in the log file:\n${logPath}` : message;
}

export interface ProcessErrorDeps {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => void): void;
  log: Pick<Logger, 'error'>;
  showErrorBox(title: string, content: string): void;
  /** Read per error — the logger starts after these handlers are installed. */
  logPath(): string;
}

/**
 * Main-process last resort for an uncaught exception or unhandled rejection:
 * every one is logged with its stack; the FIRST of the run also shows an error
 * box, later ones are only logged. The app keeps running (a registered
 * `uncaughtException` listener replaces Electron's default box and exit).
 * The listeners never throw.
 */
export function installProcessErrorHandlers(deps: ProcessErrorDeps): void {
  let shown = false;
  const report = (kind: string) => (err: unknown): void => {
    try {
      deps.log.error('app', `${kind}: ${describeError(err)}`);
    } catch { /* the logger failing must not recurse into this handler */ }
    if (shown) return;
    shown = true;
    let logPath = '';
    try { logPath = deps.logPath(); } catch { /* the box still shows, without the path */ }
    try {
      deps.showErrorBox(ERROR_BOX_TITLE, errorBoxContent(`${kind}: ${describeErrorBrief(err)}`, logPath));
    } catch { /* nothing left to report it to */ }
  };
  deps.on('uncaughtException',  report('Uncaught exception'));
  deps.on('unhandledRejection', report('Unhandled promise rejection'));
}
