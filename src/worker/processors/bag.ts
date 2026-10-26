import type {Processor, RawEvent} from './types';

export type BagEvent =
  | {type: 'bag_init';   pageId: number; slotId: number; itemId: number; quantity: number}
  | {type: 'bag_update'; pageId: number; slotId: number; itemId: number; quantity: number}
  | {type: 'bag_remove'; pageId: number; slotId: number}
  /** A full InitBagData dump may follow (Arrange, login / character load). */
  | {type: 'bag_snapshot_start'};

const RE_INIT   = /\[.*?\]TLLua: Display: \[Game\] BagMgr@:InitBagData PageId = (\d+) SlotId = (\d+) ConfigBaseId = (\d+) Num = (\d+)/;
const RE_UPDATE = /\[.*?\]TLLua: Display: \[Game\] BagMgr@:Modfy BagItem PageId = (\d+) SlotId = (\d+) ConfigBaseId = (\d+) Num = (\d+)/;
const RE_REMOVE = /\[.*?\]TLLua: Display: \[Game\] BagMgr@:RemoveBagItem PageId = (\d+) SlotId = (\d+)/;
/** Precedes every bag dump — the Arrange flow (inside ResetItemsLayout) and
 *  the login sync alike. Also written for pages no dump follows, which is
 *  harmless: a boundary only closes a dump already in progress. */
const SNAPSHOT_START = 'ItemChange@ Reset PageId=';

export class BagProcessor implements Processor {
  readonly name = 'bag';

  test(line: string): boolean {
    return line.includes('BagMgr@:') || line.includes(SNAPSHOT_START);
  }

  process(line: string): RawEvent | null {
    if (line.includes(SNAPSHOT_START)) return {type: 'bag_snapshot_start'};

    if (line.includes('InitBagData')) {
      const m = RE_INIT.exec(line);
      if (m) return {type: 'bag_init', pageId: +m[1], slotId: +m[2], itemId: +m[3], quantity: +m[4]};
    }

    if (line.includes('Modfy')) {
      const m = RE_UPDATE.exec(line);
      if (m) return {type: 'bag_update', pageId: +m[1], slotId: +m[2], itemId: +m[3], quantity: +m[4]};
    }

    if (line.includes('RemoveBagItem')) {
      const m = RE_REMOVE.exec(line);
      if (m) return {type: 'bag_remove', pageId: +m[1], slotId: +m[2]};
    }

    return null;
  }
}
