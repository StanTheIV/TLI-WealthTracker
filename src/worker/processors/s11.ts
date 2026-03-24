import type {Processor, RawEvent} from './types';

export type S11Event =
  | {type: 's11_start'}
  | {type: 's11_end'};

// Play audio PostEventAsync bgm .../Play_Mus_Gameplay_S11_Robbery_Full...  → s11_start
//   Fires when Carjack combat begins (both regular and bounty variants).
//
// Play audio PostEventAsync bgm .../Stop_Mus_Gameplay_S11_Robbery_Full...  → s11_end
//   Fires when the Carjack timer expires and combat ends.
//
// Both lines appear as duplicates in the log — the handler is idempotent.
// "Stop" must be checked first since both contain "Play_Mus_Gameplay_S11_Robbery_Full".
const STOP_MARKER  = 'Stop_Mus_Gameplay_S11_Robbery_Full';
const START_MARKER = 'Play_Mus_Gameplay_S11_Robbery_Full';

export class S11Processor implements Processor {
  readonly name = 's11';

  test(line: string): boolean {
    return line.includes('Mus_Gameplay_S11_Robbery_Full');
  }

  process(line: string): RawEvent | null {
    if (line.includes(STOP_MARKER)) return {type: 's11_end'};
    if (line.includes(START_MARKER)) return {type: 's11_start'};
    return null;
  }
}
