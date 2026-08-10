import type {Processor, RawEvent} from './types';

export type HuntingEvent =
  | {type: 'hunting_statue'}
  | {type: 'hunting_boss_start'}
  | {type: 'hunting_boss_end'};

// Hunting — the "SixGod" seasonal (no S<n> prefix). A statue at map end spawns
// the map-boss arena; the selection screen is auto-resolved when specced
// (fires ~33ms after the statue, no user input). Verified 87 events across two
// real logs, every marker exactly 1:1 per event:
//
//   FightMgr:OnGatherEnd ... cfgId 20004 → hunting_statue     (statue activated)
//   FightHunting BossStatus1             → hunting_boss_start (boss arena init —
//                                          fires with Create Map Portal + boss
//                                          Monster Created; there is NO zone
//                                          transition or LevelType for the arena)
//   FightHunting BossStatus0             → hunting_boss_end   (boss defeated —
//                                          fires TWICE ~160ms apart; the handler
//                                          de-dupes)
//
// The statue's cfgId 20004 is the interactable's config id; logicEtyId varies
// per instance. `SixGod_War_GameStart` is a different mechanic in the same
// family — we deliberately key on FightHunting/cfgId, not on 'SixGod'.
const STATUE_MARKER     = 'FightMgr:OnGatherEnd';
const STATUE_CFG        = 'cfgId 20004';
const BOSS_START_MARKER = 'FightHunting BossStatus1';
const BOSS_END_MARKER   = 'FightHunting BossStatus0';

export class HuntingProcessor implements Processor {
  readonly name = 'hunting';

  test(line: string): boolean {
    return line.includes('FightHunting BossStatus') || line.includes(STATUE_MARKER);
  }

  process(line: string): RawEvent | null {
    if (line.includes(BOSS_START_MARKER)) return {type: 'hunting_boss_start'};
    if (line.includes(BOSS_END_MARKER))   return {type: 'hunting_boss_end'};
    if (line.includes(STATUE_MARKER) && line.includes(STATUE_CFG)) return {type: 'hunting_statue'};
    return null;
  }
}
