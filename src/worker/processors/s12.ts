import type {Processor, RawEvent} from './types';

export type S12Event =
  | {type: 's12_entry'}
  | {type: 'map_portal_created'; cfgId: number};

// USceneEffectMgr::S12SwitchFinish → s12_entry
//   Fires on every stage transition (1→2, 2→3). Only the first entry starts tracking.
//
// Create Map Portal cfgId 52       → map_portal_created
//   cfgId 52 = "exit to map" portal, appears when completing the final Overrealm stage.
//   Other cfgIds (50, 51) are internal portals and are ignored.
const RE_ENTRY  = /S12SwitchFinish/;
const RE_PORTAL = /Create Map Portal cfgId (\d+)/;

const OVERREALM_EXIT_PORTAL = 52;

export class S12Processor implements Processor {
  readonly name = 's12';

  test(line: string): boolean {
    return line.includes('S12SwitchFinish') || line.includes('Create Map Portal');
  }

  process(line: string): RawEvent | null {
    if (RE_ENTRY.test(line)) return {type: 's12_entry'};

    const m = RE_PORTAL.exec(line);
    if (m) {
      const cfgId = +m[1];
      if (cfgId === OVERREALM_EXIT_PORTAL) return {type: 'map_portal_created', cfgId};
    }

    return null;
  }
}
