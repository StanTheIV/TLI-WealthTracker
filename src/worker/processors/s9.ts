import type {Processor, RawEvent} from './types';

export type S9Event =
  | {type: 's9_minigame'}
  | {type: 's9_fight'};

// S9 "Arcana" (Tarot / Fateful Contest) — minigame → fight lifecycle.
//
//   S9Taro Run       → s9_minigame  (Tarot Path panel opened OR reopened)
//   S9Challenge Run  → s9_fight     (Fateful Contest fight scene begins)
//
// Only the two "Run" markers carry meaning for tracking. `S9Taro Hide` and
// `S9Taro Destory` are panel teardown that fire on every run (both when the
// player commits to the fight and when they abandon the minigame), so they
// convey nothing actionable and are ignored. The ArcanaHandler starts on the
// first `s9_minigame`, resumes on any later `s9_minigame`/`s9_fight`, and
// finishes when the player leaves the Fateful Contest scene (via
// zone_transition, handled engine-side).
const RE_MINIGAME = /S9Taro Run/;
const RE_FIGHT    = /S9Challenge Run/;

export class S9Processor implements Processor {
  readonly name = 's9';

  test(line: string): boolean {
    return line.includes('S9Taro') || line.includes('S9Challenge');
  }

  process(line: string): RawEvent | null {
    if (RE_MINIGAME.test(line)) return {type: 's9_minigame'};
    if (RE_FIGHT.test(line))    return {type: 's9_fight'};
    return null;
  }
}
