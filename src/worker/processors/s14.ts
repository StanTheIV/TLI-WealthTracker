import type {Processor, RawEvent} from './types';

export type S14Event = {type: 's14_strum'};

// UECtrlComponent@ DoAction S14GameplayStart → s14_strum
//   Fires once per strum during a Lunaria (S14 "MingYue") encounter inside a
//   Netherrealm map. Strum is the only event we listen for: the first strum
//   starts the seasonal tracker AND arms a pausing loot timer; each subsequent
//   strum refreshes the timer (or resumes the tracker if the timer already
//   expired between episodes). When the timer expires, the tracker pauses
//   in place. ZoneHandler finishes it on town entry.
const STRUM_MARKER = 'UECtrlComponent@ DoAction S14GameplayStart';

export class S14Processor implements Processor {
  readonly name = 's14';

  test(line: string): boolean {
    return line.includes('S14GameplayStart');
  }

  process(line: string): RawEvent | null {
    if (line.includes(STRUM_MARKER)) return {type: 's14_strum'};
    return null;
  }
}
