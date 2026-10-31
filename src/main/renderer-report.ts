/**
 * Renderer error reports (`logging:report`), electron-free: a renderer stuck
 * in an error loop must not flood the log file. Per key (window), a fixed
 * `windowMs` window logs the first `max` reports, one 'suppress', then drops.
 */
import {MAX_ERROR_LENGTH} from '@/shared/describe-error';

export type ReportVerdict = 'log' | 'suppress' | 'drop';

export interface ReportRateLimiter {
  /** Count one report for `key` (the window) and say what to do with it. */
  check(key: string): ReportVerdict;
}

export function createReportRateLimiter(opts: {max: number; windowMs: number; now: () => number}): ReportRateLimiter {
  const windows = new Map<string, {start: number; count: number}>();
  return {
    check(key) {
      const t = opts.now();
      let w = windows.get(key);
      if (!w || t - w.start >= opts.windowMs) {
        w = {start: t, count: 0};
        windows.set(key, w);
      }
      w.count++;
      if (w.count <= opts.max) return 'log';
      return w.count === opts.max + 1 ? 'suppress' : 'drop';
    },
  };
}

const MAX_TAG_LENGTH = 100;

/** Cut to `max` characters, marked. */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated]` : s;
}

/** The log line for one report. IPC fields are `unknown`: a non-string is named, never stringified; strings are capped. */
export function formatRendererReport(windowName: string, tag: unknown, message: unknown): string {
  const t = typeof tag     === 'string' ? clip(tag, MAX_TAG_LENGTH)       : '[invalid tag]';
  const m = typeof message === 'string' ? clip(message, MAX_ERROR_LENGTH) : '[invalid message]';
  return `${windowName} renderer error [${t}]: ${m}`;
}

/** The one line that stands in for the reports dropped until the window ends. */
export function suppressedReportLine(windowName: string, max: number, windowMs: number): string {
  return `${windowName}: more than ${max} renderer errors within ${Math.round(windowMs / 1000)} s — further ones are not logged until it ends`;
}
