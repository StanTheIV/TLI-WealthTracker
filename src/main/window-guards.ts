import type {Logger} from './logger';

/** The slice of Electron's `WebContents` the guards use — structural, so this module loads without electron. */
export interface GuardableWebContents {
  on(event: 'will-navigate', listener: (event: {url: string; preventDefault(): void}) => void): unknown;
  setWindowOpenHandler(handler: (details: {url: string}) => {action: 'deny'}): void;
}

const MAX_URL_LENGTH = 200;

/** A URL for the log line: a non-string is named, a long one is cut. */
function describeUrl(url: unknown): string {
  if (typeof url !== 'string') return '[no url]';
  return url.length > MAX_URL_LENGTH ? `${url.slice(0, MAX_URL_LENGTH)}… [truncated]` : url;
}

/** Prevent every page-initiated navigation (link, `window.location`, dropped file) and deny every
 *  `window.open`, logged. Our `loadURL`/`loadFile`/`reload` and hash changes don't emit `will-navigate`. */
export function lockDownWebContents(wc: GuardableWebContents, name: string, log: Pick<Logger, 'warn'>): void {
  wc.on('will-navigate', (event) => {
    event.preventDefault();
    log.warn('app', `${name}: blocked navigation to ${describeUrl(event.url)}`);
  });
  wc.setWindowOpenHandler((details) => {
    log.warn('app', `${name}: blocked window.open of ${describeUrl(details?.url)}`);
    return {action: 'deny'};
  });
}
