import type {Dispatcher} from './dispatcher';
import type {RawEvent} from './processors/types';
import {describeError} from '@/shared/describe-error';

/** How much of a failing line goes into its report. */
const MAX_LINE_IN_REPORT = 200;

/**
 * Feed a batch of log lines through the dispatcher, posting each line's
 * events in order. A line whose processor throws posts nothing, is reported
 * (`report`: the error plus the line, cut to MAX_LINE_IN_REPORT chars) and
 * skipped; the next line goes on. A throwing `report` is swallowed — a failing
 * report channel must not cost the rest of the batch.
 *
 * The live worker's guard only: Dispatcher itself stays loud, so the log
 * replayer and the goldens still fail on a throwing processor.
 */
export function dispatchLines(
  dispatcher: Dispatcher,
  lines:      readonly string[],
  post:       (event: RawEvent) => void,
  report:     (message: string) => void,
): void {
  for (const line of lines) {
    let events: RawEvent[];
    try {
      events = dispatcher.dispatch(line);
    } catch (err) {
      try {
        report(`Processor failed on line "${line.slice(0, MAX_LINE_IN_REPORT)}": ${describeError(err)}`);
      } catch {
        // Nowhere left to say it; the batch goes on.
      }
      continue;
    }
    for (const event of events) post(event);
  }
}
