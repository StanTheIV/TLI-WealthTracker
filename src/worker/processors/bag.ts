import type {Processor, RawEvent} from './types';

export type BagEvent =
  | {type: 'bag_init';   pageId: number; slotId: number; itemId: number; quantity: number}
  | {type: 'bag_update'; pageId: number; slotId: number; itemId: number; quantity: number}
  | {type: 'bag_remove'; pageId: number; slotId: number};

const RE_INIT   = /\[.*?\]TLLua: Display: \[Game\] BagMgr@:InitBagData PageId = (\d+) SlotId = (\d+) ConfigBaseId = (\d+) Num = (\d+)/;
const RE_UPDATE = /\[.*?\]TLLua: Display: \[Game\] BagMgr@:Modfy BagItem PageId = (\d+) SlotId = (\d+) ConfigBaseId = (\d+) Num = (\d+)/;
const RE_REMOVE = /\[.*?\]TLLua: Display: \[Game\] BagMgr@:RemoveBagItem PageId = (\d+) SlotId = (\d+)/;

export class BagProcessor implements Processor {
  readonly name = 'bag';

  test(line: string): boolean {
    return line.includes('BagMgr@:');
  }

  process(line: string): RawEvent | null {
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
