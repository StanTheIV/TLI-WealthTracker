import type {Processor, RawEvent} from './types';

export type LevelTypeEvent = {type: 'level_type'; levelType: number};

const RE_LEVEL_TYPE = /PreloadLevelType = (\d+)/;

export class LevelTypeProcessor implements Processor {
  readonly name = 'level-type';

  test(line: string): boolean {
    return line.includes('PreloadLevelType');
  }

  process(line: string): RawEvent | null {
    const m = RE_LEVEL_TYPE.exec(line);
    if (m) return {type: 'level_type', levelType: +m[1]};
    return null;
  }
}
