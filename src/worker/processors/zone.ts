import type {Processor, RawEvent} from './types';

export type ZoneEvent = {type: 'zone_transition'; fromScene: string; toScene: string};

const RE_ZONE = /PageApplyBase@ _UpdateGameEnd: LastSceneName = World'([^']+)' NextSceneName = World'([^']+)'/;

export class ZoneProcessor implements Processor {
  readonly name = 'zone';

  test(line: string): boolean {
    return line.includes('_UpdateGameEnd');
  }

  process(line: string): RawEvent | null {
    const m = RE_ZONE.exec(line);
    if (m) return {type: 'zone_transition', fromScene: m[1], toScene: m[2]};
    return null;
  }
}
