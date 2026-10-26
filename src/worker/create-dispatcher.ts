import {Dispatcher} from './dispatcher';
import {BagProcessor} from './processors/bag';
import {ZoneProcessor} from './processors/zone';
import {LevelTypeProcessor} from './processors/level-type';
import {PriceProcessor} from './processors/price';
import {S13Processor} from './processors/s13';
import {S16Processor} from './processors/s16';
import {S12Processor} from './processors/s12';
import {S9Processor} from './processors/s9';
import {S11Processor} from './processors/s11';
import {S7Processor} from './processors/s7';
import {S14Processor} from './processors/s14';
import {S10Processor} from './processors/s10';
import {HuntingProcessor} from './processors/hunting';
import {AfterlightProcessor} from './processors/afterlight';

/**
 * The production processor chain. Shared by the worker, the log replayer and
 * the test fixtures so they can never drift apart.
 *
 * Returns a fresh Dispatcher each call — PriceProcessor is stateful (buffers
 * multi-line socket blocks), so a replay must never reuse one.
 */
export function createDispatcher(): Dispatcher {
  const dispatcher = new Dispatcher();
  dispatcher.register(new BagProcessor());
  dispatcher.register(new ZoneProcessor());
  dispatcher.register(new LevelTypeProcessor());
  dispatcher.register(new PriceProcessor());
  dispatcher.register(new S13Processor());
  dispatcher.register(new S16Processor());
  dispatcher.register(new S12Processor());
  dispatcher.register(new S9Processor());
  dispatcher.register(new S11Processor());
  dispatcher.register(new S7Processor());
  dispatcher.register(new S14Processor());
  dispatcher.register(new S10Processor());
  dispatcher.register(new HuntingProcessor());
  dispatcher.register(new AfterlightProcessor());
  return dispatcher;
}
