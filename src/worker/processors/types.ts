import type {BagEvent} from './bag';
import type {ZoneEvent} from './zone';
import type {LevelTypeEvent} from './level-type';
import type {PriceEvent} from './price';
import type {S13Event} from './s13';
import type {S12Event} from './s12';
import type {S11Event} from './s11';
import type {CurrencyEvent} from './currency';

// ---------------------------------------------------------------------------
// RawEvent — assembled union of all processor event types.
// To add a new processor: export its event type from its own file, then add
// one import + one line to this union.
// ---------------------------------------------------------------------------

export type RawEvent =
  | BagEvent
  | ZoneEvent
  | LevelTypeEvent
  | PriceEvent
  | S13Event
  | S12Event
  | S11Event
  | CurrencyEvent
  | {type: 'reader_ready'}
  | {type: 'reader_error'; message: string}
  | {type: 'worker_log'; logType: 'info' | 'warn' | 'error' | 'debug'; message: string};

// ---------------------------------------------------------------------------
// Processor interface — each processor registers with the dispatcher
// and handles a specific category of log lines.
// ---------------------------------------------------------------------------

export interface Processor {
  /** Short name for debugging (e.g. 'bag', 'zone') */
  readonly name: string;

  /**
   * Fast pre-check — called for every line.
   * Return true if this processor *might* handle the line.
   * Should use simple string checks (includes/startsWith), no regex.
   */
  test(line: string): boolean;

  /**
   * Parse the line and return an event, or null if it doesn't match after all.
   * Only called when test() returned true.
   */
  process(line: string): RawEvent | null;
}
