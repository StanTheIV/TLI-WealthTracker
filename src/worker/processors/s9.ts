import type {Processor, RawEvent} from './types';

export type S9Event =
  | {type: 's9_minigame'}
  | {type: 's9_fight'}
  | {type: 's9_close'};

// S9 "Arcana" (Tarot / Fateful Contest) — minigame → fight lifecycle.
//
//   S9Taro Run                          → s9_minigame  (Tarot Path panel opened OR reopened)
//   S9Challenge Run                     → s9_fight     (Fateful Contest fight scene begins)
//   OnPageBackEvent FuncId = …_S9TaroCtrl → s9_close    (player backed out of the panel)
//
// The two "Run" markers drive start/resume. `S9Taro Hide` and `S9Taro Destory`
// are panel teardown that fire on EVERY run — both when the player commits to
// the fight AND when they abandon the minigame — so they can't distinguish an
// abandon from a commit and are ignored.
//
// A genuine abandon (backing out of the Tarot Path panel without fighting) is
// the ONLY thing that emits `PageApplyBase@ OnPageBackEvent FuncId = <id>_S9TaroCtrl`
// (verified against real logs: it appears exactly once per abandon, never on a
// fight-commit, which closes the panel via `S9Challenge Run`/`FightToFightScene`
// instead). The ArcanaHandler pauses the tracker on `s9_close`; a later
// `s9_minigame`/`s9_fight` resumes it.
const RE_MINIGAME = /S9Taro Run/;
const RE_FIGHT    = /S9Challenge Run/;
const RE_CLOSE    = /OnPageBackEvent FuncId = \d+_S9TaroCtrl/;

export class S9Processor implements Processor {
  readonly name = 's9';

  test(line: string): boolean {
    return line.includes('S9Taro') || line.includes('S9Challenge') || line.includes('S9TaroCtrl');
  }

  process(line: string): RawEvent | null {
    if (RE_MINIGAME.test(line)) return {type: 's9_minigame'};
    if (RE_FIGHT.test(line))    return {type: 's9_fight'};
    if (RE_CLOSE.test(line))    return {type: 's9_close'};
    return null;
  }
}
