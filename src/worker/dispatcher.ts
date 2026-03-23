import type {Processor, RawEvent} from './processors/types';

/**
 * Dispatcher — routes log lines to registered processors.
 * Iterates all processors per line; a line can match multiple processors.
 */
export class Dispatcher {
  private _processors: Processor[] = [];

  register(processor: Processor): void {
    this._processors.push(processor);
  }

  /**
   * Feed a single complete log line.
   * Returns all events produced by matching processors.
   */
  dispatch(line: string): RawEvent[] {
    const events: RawEvent[] = [];
    for (const p of this._processors) {
      if (p.test(line)) {
        const event = p.process(line);
        if (event) events.push(event);
      }
    }
    return events;
  }
}
