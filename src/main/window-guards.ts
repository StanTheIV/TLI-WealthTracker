import type {Logger} from './logger';

/** The slice of Electron's `WebContents` the guards use — structural, so this module loads without electron. */
export interface GuardableWebContents {
  on(event: 'will-navigate', listener: (event: {url: string; preventDefault(): void}) => void): unknown;
  getURL(): string;
  setWindowOpenHandler(handler: (details: {url: string}) => {action: 'deny'}): void;
}

const MAX_URL_LENGTH = 200;

/** A URL for the log line: a non-string is named, a long one is cut. */
function describeUrl(url: unknown): string {
  if (typeof url !== 'string') return '[no url]';
  return url.length > MAX_URL_LENGTH ? `${url.slice(0, MAX_URL_LENGTH)}… [truncated]` : url;
}

/** `url` without its `#hash`, normalised; null for a non-string or unparsable URL. */
function withoutHash(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

/** True when `target` is the page's current URL (hash ignored) — the page reloading itself. Never throws. */
function isReloadOfCurrentPage(wc: GuardableWebContents, target: unknown): boolean {
  const to = withoutHash(target);
  if (to === null) return false;
  let current: unknown;
  try {
    current = wc.getURL();
  } catch {
    return false;
  }
  return withoutHash(current) === to;
}

/** Prevent every page-initiated navigation (link, `window.location = other`, dropped file) and deny every
 *  `window.open`, logged. A navigation to the current URL (hash ignored) passes: the docs don't say whether
 *  `location.reload()` emits `will-navigate`, and the ErrorBoundary's Reload and Vite's full-reload rely on it. */
export function lockDownWebContents(wc: GuardableWebContents, name: string, log: Pick<Logger, 'warn'>): void {
  wc.on('will-navigate', (event) => {
    if (isReloadOfCurrentPage(wc, event.url)) return;
    event.preventDefault();
    log.warn('app', `${name}: blocked navigation to ${describeUrl(event.url)}`);
  });
  wc.setWindowOpenHandler((details) => {
    log.warn('app', `${name}: blocked window.open of ${describeUrl(details?.url)}`);
    return {action: 'deny'};
  });
}
