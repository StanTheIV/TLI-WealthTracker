import type {Processor, RawEvent} from './types';

export type S12Event =
  | {type: 's12_entry'}
  | {type: 's12_exit'};

/**
 * S12Processor — Overrealm entry/exit detection.
 *
 *   Entry: `LevelMgr@ LevelUid, LevelType, LevelId = … 25 …` — the player
 *          loaded into the Overrealm pact (LevelType 25 is reserved for it).
 *   Exit:  `gameplay type 8001 received notifyId 101` — Overrealm cleared
 *          successfully; the post-mechanic loot window starts.
 *
 * The previously-trusted `USceneEffectMgr::S12SwitchFinish` line fires on
 * both directions of the visual switch (entering AND exiting), so it's not
 * a reliable entry signal on its own. The LevelType transition is.
 *
 * Death/abandon (no notifyId 101) is handled outside this processor: the
 * tracker stays in ctx.seasonals['overrealm'] and ZoneHandler finishes it
 * on town entry like any other live seasonal.
 */
const RE_ENTRY = /LevelMgr@ LevelUid, LevelType, LevelId = \d+ 25 \d+/;
const RE_EXIT  = /gameplay type 8001 received notifyId 101\b/;

export class S12Processor implements Processor {
  readonly name = 's12';

  test(line: string): boolean {
    return (
      (line.includes('LevelMgr@ LevelUid') && line.includes(' 25 ')) ||
      line.includes('gameplay type 8001 received notifyId 101')
    );
  }

  process(line: string): RawEvent | null {
    if (RE_ENTRY.test(line)) return {type: 's12_entry'};
    if (RE_EXIT.test(line))  return {type: 's12_exit'};
    return null;
  }
}
