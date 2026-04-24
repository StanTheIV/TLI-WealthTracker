import type {Processor, RawEvent} from './types';

export type S7Event =
  | {type: 's7_start'}
  | {type: 's7_success'}
  | {type: 's7_fail'};

// S7GamePlayMgr@HandleS7PushData GamePlayState = -1 PushState = S7GamePlayStateStart
//   → s7_start (player begins a Clockwork Ballet game)
//
// S7GamePlayMgr@HandleS7PushData GamePlayState = S7GamePlayStateStart PushState = S7GamePlayStateSuccess
//   → s7_success (game completed)
//
// PageBase@ OpenFlow0! Switch = true S7GamePlayFailStateItem <id>
//   → s7_fail (game failed — the game emits no HandleS7PushData line, only opens the fail UI)
//
// Heartbeat pushes (State=Start, PushState=Start) repeat every ~5-20s during an active
// game and are ignored.
const PUSH_PREFIX     = 'S7GamePlayMgr@HandleS7PushData';
const START_MARKER    = 'GamePlayState = -1 PushState = S7GamePlayStateStart';
const SUCCESS_MARKER  = 'PushState = S7GamePlayStateSuccess';
const FAIL_UI_MARKER  = 'S7GamePlayFailStateItem';

export class S7Processor implements Processor {
  readonly name = 's7';

  test(line: string): boolean {
    return line.includes(PUSH_PREFIX) || line.includes(FAIL_UI_MARKER);
  }

  process(line: string): RawEvent | null {
    if (line.includes(PUSH_PREFIX)) {
      if (line.includes(START_MARKER))   return {type: 's7_start'};
      if (line.includes(SUCCESS_MARKER)) return {type: 's7_success'};
      return null; // heartbeat or other push we don't track
    }

    // Only treat the OpenFlow0 opening of the fail page as the fail signal —
    // subsequent references to the same widget during teardown will be ignored.
    if (line.includes(FAIL_UI_MARKER) && line.includes('OpenFlow0')) {
      return {type: 's7_fail'};
    }

    return null;
  }
}
