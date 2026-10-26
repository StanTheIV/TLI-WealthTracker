import {createDispatcher} from '@/worker/create-dispatcher';
import {parseLogTimestamp} from './log-source';

/** Tartarus board lines carry a server-side run id; fixtures get a constant. */
const RE_RUN_ID = /\brunId=[0-9A-Fa-f-]+/g;
export const REDACTED_RUN_ID = 'runId=00000000-0000-0000-0000-000000000000';

export interface ScrubStats {
  kept:    number;
  dropped: number;
  /** Kept lines without their own timestamp prefix: a scrubbed file gives
   *  them the previous KEPT line's time, not the original predecessor's. */
  unstamped: number;
}

export interface Scrubber {
  /** The line as it goes into a fixture, or null when it is dropped. Feed lines in log order. */
  scrub(text: string): string | null;
  readonly stats: ScrubStats;
}

/**
 * Reduces a log slice to the lines the tracker reads: a line is kept when the
 * production processor chain yields at least one event for it — one stateful
 * dispatcher over the whole slice, exactly as a replay of it runs.
 */
export function createScrubber(): Scrubber {
  const dispatcher = createDispatcher();
  const stats: ScrubStats = {kept: 0, dropped: 0, unstamped: 0};
  return {
    stats,
    scrub(text) {
      if (dispatcher.dispatch(text).length === 0) {
        stats.dropped++;
        return null;
      }
      stats.kept++;
      if (parseLogTimestamp(text) === null) stats.unstamped++;
      return text.replace(RE_RUN_ID, REDACTED_RUN_ID);
    },
  };
}
