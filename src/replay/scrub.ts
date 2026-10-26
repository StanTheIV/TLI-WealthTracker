import {createDispatcher} from '@/worker/create-dispatcher';
import {formatLogTimestamp, parseLogTimestamp, type LogLine} from './log-source';

/** Tartarus board lines carry a server-side run id; fixtures get a constant. */
const RE_RUN_ID = /\brunId=[0-9A-Fa-f-]+/g;
export const REDACTED_RUN_ID = 'runId=00000000-0000-0000-0000-000000000000';

export interface ScrubStats {
  kept:    number;
  dropped: number;
  /** Kept lines without their own timestamp prefix: a scrubbed file gives
   *  them the previous KEPT line's time, not the original predecessor's. */
  unstamped: number;
  /** Bare-timestamp lines standing in for a dropped first or last line. */
  anchors: number;
}

export interface Scrubber {
  /** The line as it goes into a fixture, or null when it is dropped. Feed lines in log order. */
  scrub(line: LogLine): string | null;
  /** After the last line: the closing time anchor, or null when the last line was kept. */
  finish(): string | null;
  readonly stats: ScrubStats;
}

/**
 * Reduces a log slice to the lines the tracker reads: a line is kept when the
 * production processor chain yields at least one event for it — one stateful
 * dispatcher over the whole slice, exactly as a replay of it runs.
 *
 * The slice's first line anchors the replay's 250 ms poll grid and its last
 * line starts the settle period (the session's end time), so a dropped first
 * or last line is replaced by its bare timestamp — matched by no processor —
 * and the scrubbed slice replays on the raw slice's clock.
 */
export function createScrubber(): Scrubber {
  const dispatcher = createDispatcher();
  const stats: ScrubStats = {kept: 0, dropped: 0, unstamped: 0, anchors: 0};
  let first = true;
  /** The last line's time when it was dropped; null when it was kept. */
  let droppedLastTs: number | null = null;

  const anchor = (ts: number): string => {
    stats.anchors++;
    return formatLogTimestamp(ts);
  };

  return {
    stats,
    scrub(line) {
      const isFirst = first;
      first = false;
      if (dispatcher.dispatch(line.text).length === 0) {
        stats.dropped++;
        droppedLastTs = line.ts;
        return isFirst ? anchor(line.ts) : null;
      }
      droppedLastTs = null;
      stats.kept++;
      if (parseLogTimestamp(line.text) === null) stats.unstamped++;
      return line.text.replace(RE_RUN_ID, REDACTED_RUN_ID);
    },
    finish() {
      // A single-line slice whose line was dropped already got its anchor.
      if (droppedLastTs === null || stats.kept + stats.dropped === 1) return null;
      return anchor(droppedLastTs);
    },
  };
}
