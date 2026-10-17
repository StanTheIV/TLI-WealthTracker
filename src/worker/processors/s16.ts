import type {Processor, RawEvent} from './types';

export type S16Event =
  | {type: 's16_board_open'; settled: boolean}
  | {type: 's16_board_close'}
  | {type: 's16_suppress'}
  | {type: 's16_ignore'};

// [S16BGM] board Begin runId=… IsSettled=false  → s16_board_open (live board — fresh start or reopen)
// [S16BGM] board Begin runId=… IsSettled=true   → s16_board_open settled (replay of the PREVIOUS,
//                                                 already-finished board's checkout — shown on every
//                                                 device open and dismissed with Ignore)
// S16BoardMain Destory                          → s16_board_close (Esc mid-board, or after a checkout)
// normal-click …CheckOut_StartChallenge         → s16_suppress (commit → prison fight scene)
// normal-click …CheckOut_AbandonChallenge       → s16_ignore
//
// Anchored to avoid sibling lines: "TipMsgShowMgr … PageName = S16BoardMain , PageRunState = Destory"
// and "LogDataTable … requested row '…_Btn_S16GamePlay_CheckOut_StartChallenge'" fire alongside.
const RE_BOARD_OPEN  = /\[S16BGM\] board Begin .*IsSettled=(true|false)/;
const RE_BOARD_CLOSE = /\bS16BoardMain Destory\b/;
const RE_SUPPRESS    = /normal-click Btn_S16GamePlay_CheckOut_StartChallenge/;
const RE_IGNORE      = /normal-click Btn_S16GamePlay_CheckOut_AbandonChallenge/;

export class S16Processor implements Processor {
  readonly name = 's16';

  test(line: string): boolean {
    return line.includes('S16');
  }

  process(line: string): RawEvent | null {
    const open = RE_BOARD_OPEN.exec(line);
    if (open)                       return {type: 's16_board_open', settled: open[1] === 'true'};
    if (RE_BOARD_CLOSE.test(line))  return {type: 's16_board_close'};
    if (RE_SUPPRESS.test(line))     return {type: 's16_suppress'};
    if (RE_IGNORE.test(line))       return {type: 's16_ignore'};
    return null;
  }
}
