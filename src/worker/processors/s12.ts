import type {Processor, RawEvent} from './types';

export type S12Event =
  | {type: 's12_entry'}
  | {type: 's12_exit'};

// USceneEffectMgr::S12SwitchFinish → s12_entry
//   Fires on every Overrealm pact/area switch:
//     - the initial entry (Netherrealm → Overrealm)
//     - each stage transition inside (stage 1 → 2, 2 → 3, …)
//     - the exit transition (Overrealm → Netherrealm)
//   The handler decides which one matters based on its own state.
//
// gameplay type 8001 received notifyId 101 → s12_exit
//   Fires once when the Overrealm pact deactivates and the player is back in
//   the Netherrealm (regular map). Arrives ~200ms after the exit
//   S12SwitchFinish. This is the trigger that arms the loot-collection timer.
const RE_ENTRY = /S12SwitchFinish/;
const RE_EXIT  = /gameplay type 8001 received notifyId 101\b/;

export class S12Processor implements Processor {
  readonly name = 's12';

  test(line: string): boolean {
    return line.includes('S12SwitchFinish') || line.includes('gameplay type 8001 received notifyId 101');
  }

  process(line: string): RawEvent | null {
    if (RE_ENTRY.test(line)) return {type: 's12_entry'};
    if (RE_EXIT.test(line))  return {type: 's12_exit'};
    return null;
  }
}
