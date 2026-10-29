import {ipcMain, type WebContents} from 'electron';
import {getLogFilePath, log} from '@/main/logger';
import {createReportRateLimiter, formatRendererReport, suppressedReportLine} from '@/main/renderer-report';

const REPORTS_PER_WINDOW = 10;
const REPORT_WINDOW_MS   = 60_000;

export interface LoggingHandlerDeps {
  /** The sender's window for the log line and the rate limit ('main window', 'overlay', …). */
  windowName(sender: WebContents): string;
  now?: () => number;
}

export function registerLoggingHandlers(deps: LoggingHandlerDeps): void {
  ipcMain.handle('logging:get-log-path', () => getLogFilePath());

  // A throw in the listener would reach the process handler's error box — never for a report.
  const limiter = createReportRateLimiter({
    max: REPORTS_PER_WINDOW, windowMs: REPORT_WINDOW_MS, now: deps.now ?? (() => Date.now()),
  });
  ipcMain.on('logging:report', (event, tag: unknown, message: unknown) => {
    try {
      const name    = deps.windowName(event.sender);
      const verdict = limiter.check(name);
      if (verdict === 'log') {
        log.error('app', formatRendererReport(name, tag, message));
      } else if (verdict === 'suppress') {
        log.error('app', suppressedReportLine(name, REPORTS_PER_WINDOW, REPORT_WINDOW_MS));
      }
    } catch { /* a failed report is not worth a second error */ }
  });

  log.debug('ipc', 'Logging handlers registered');
}
