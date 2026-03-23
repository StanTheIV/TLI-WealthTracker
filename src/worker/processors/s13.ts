import type {Processor, RawEvent} from './types';

export type S13Event =
  | {type: 's13_start'}
  | {type: 's13_window_close'}
  | {type: 's13_abandon'};

// S13GamePlayMain Run          → s13_start
// S13GamePlayMain.*Destory     → s13_window_close  (window closed, session kept — player may reopen)
// S13GamePlay Destory          → s13_abandon        (full exit, no "Main")
//
// Order matters: window_close check must come before abandon because
// "S13GamePlay Destory" is a substring of "S13GamePlayMain.*Destory".
const RE_WINDOW_CLOSE = /S13GamePlayMain.*Destory/;
const RE_START        = /S13GamePlayMain Run/;
const RE_ABANDON      = /S13GamePlay Destory/;

export class S13Processor implements Processor {
  readonly name = 's13';

  test(line: string): boolean {
    return line.includes('S13GamePlay');
  }

  process(line: string): RawEvent | null {
    if (RE_WINDOW_CLOSE.test(line)) return {type: 's13_window_close'};
    if (RE_ABANDON.test(line))      return {type: 's13_abandon'};
    if (RE_START.test(line))        return {type: 's13_start'};
    return null;
  }
}
