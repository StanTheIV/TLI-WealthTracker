/**
 * Regression for the 2026-10-25 double Arrange: two sort clicks 220 ms apart
 * made the game write two identical full InitBagData dumps inside one 300 ms
 * resort window. The merged buffer summed every stack twice, the whole bag was
 * credited as drops, and wealth doubled.
 *
 * Driven by the real log slice (fixtures/arrange-double-2026-10-25.txt, lines
 * 1944270–1944890 of that day's UE_game.log) through the log replayer.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {describe, it, expect} from 'vitest';
import {BagState} from '@/main/engine/bag-state';
import {SqliteSessionStore} from '@/main/db/session-store';
import {readLogText, type LogLine} from '@/replay/log-source';
import {replay, type ReplayOptions, type ReplayResult} from '@/replay/replay';
import {sumSlots} from '@/replay/invariants';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';

/** Each replay persists into its own fresh DB. */
const run = (opts: Omit<ReplayOptions, 'persistence'>) =>
  replay({...opts, persistence: {store: new SqliteSessionStore(openMigratedNodeSqlite()), readPrices: () => ({})}});

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'arrange-double-2026-10-25.txt'), 'utf8');
const LINES   = [...readLogText(FIXTURE)];

const RE_INIT = /InitBagData PageId = (\d+) SlotId = (\d+) ConfigBaseId = (\d+) Num = (\d+)/;
const SECOND_CLICK = LINES.filter(l => l.text.includes('ResetItemsLayout start'))[1].lineNo;

/** The first dump alone — the bag as it stood at the double click. */
const DUMP_1 = LINES.filter(l => RE_INIT.test(l.text) && l.lineNo < SECOND_CLICK);
const BAG = sumSlots(DUMP_1.map(l => {
  const m = RE_INIT.exec(l.text)!;
  return {itemId: +m[3], quantity: +m[4]};
}));

/** The same dump replayed 10 s earlier, so the engine is already tracking
 *  when the double click arrives. */
const BOOT: LogLine[] = DUMP_1.map(l => ({...l, ts: l.ts - 10_000}));

const MAP_ENTRY: LogLine = {
  lineNo: 0,
  ts:     LINES[0].ts - 5_000,
  text:   "PageApplyBase@ _UpdateGameEnd: LastSceneName = World'XZ_YuJinZhiXiBiNanSuo200' NextSceneName = World'/Game/Art/Maps/S5_Boss'",
};

const MAP_EXIT: LogLine = {
  lineNo: 0,
  ts:     LINES[LINES.length - 1].ts + 5_000,
  text:   "PageApplyBase@ _UpdateGameEnd: LastSceneName = World'/Game/Art/Maps/S5_Boss' NextSceneName = World'XZ_YuJinZhiXiBiNanSuo200'",
};

/** The fixture with every dump-boundary line removed. */
const withoutMarkers = (ls: LogLine[]) => ls.filter(l => !l.text.includes('ItemChange@ Reset PageId=') && !l.text.includes('ResetItemsLayout'));

/** A Reset line for a page no dump follows — the game writes these on its own. */
const strayMarker = (ts: number): LogLine => ({lineNo: 0, ts, text: '[2026.10.25-11.04.23:500][ 1]TLLua: Display: [Game] ItemChange@ Reset PageId=-96'});

function credited(r: ReplayResult): number[] {
  return r.events.flatMap(e => (e.event.type === 'drop' && e.event.change > 0 ? [e.event.itemId] : []));
}

function realAnomalies(r: ReplayResult) {
  // The double dump itself is expected — it is the trigger, not a fault.
  return r.anomalies.filter(a => a.kind !== 'double-dump');
}

describe('double Arrange while tracking', () => {
  it('fixture holds two identical full dumps', () => {
    expect(DUMP_1).toHaveLength(218);
    expect(LINES.filter(l => RE_INIT.test(l.text))).toHaveLength(436);
  });

  it('keeps the inventory at one bag and credits nothing (town)', async () => {
    const r = await run({source: [...BOOT, ...LINES]});
    expect(realAnomalies(r)).toEqual([]);
    expect(r.anomalies.map(a => a.kind)).toContain('double-dump');
    expect(r.finalInventory).toEqual(BAG);
    expect(credited(r)).toEqual([]);
  });

  it('credits nothing inside a map, where deltas flush straight into the trackers', async () => {
    const r = await run({source: [...BOOT, MAP_ENTRY, ...LINES, MAP_EXIT]});
    expect(realAnomalies(r)).toEqual([]);
    expect(r.finalInventory).toEqual(BAG);
    expect(credited(r)).toEqual([]);
    const map = r.sessions[0].rows.find(row => row.seasonalType === null);
    expect(map?.drops).toEqual({});
  });

  it('stays exact without the dump marker — BagState counts each slot once', async () => {
    const r = await run({source: [...BOOT, MAP_ENTRY, ...withoutMarkers(LINES)]});
    expect(realAnomalies(r)).toEqual([]);
    expect(r.finalInventory).toEqual(BAG);
    expect(credited(r)).toEqual([]);
  });

  it('is identical in exact mode, where the dumps arrive 218 ms apart', async () => {
    const r = await run({source: [...BOOT, MAP_ENTRY, ...LINES], mode: 'exact'});
    expect(realAnomalies(r)).toEqual([]);
    expect(r.finalInventory).toEqual(BAG);
    expect(credited(r)).toEqual([]);
  });
});

describe('double Arrange as the initialising sort', () => {
  it('takes one bag as the baseline', async () => {
    const r = await run({source: LINES});
    expect(realAnomalies(r)).toEqual([]);
    expect(r.finalInventory).toEqual(BAG);
  });

  it('takes one bag as the baseline without the marker', async () => {
    const r = await run({source: withoutMarkers(LINES)});
    expect(realAnomalies(r)).toEqual([]);
    expect(r.finalInventory).toEqual(BAG);
  });

  it('a stray marker right after the boot dump does not empty the baseline', async () => {
    // The boot dump is complete; a Reset line for another page lands inside
    // the init debounce. It must close (apply) the dump, not discard it.
    const stray = strayMarker(BOOT[BOOT.length - 1].ts + 10);
    const r = await run({source: [...BOOT, stray, ...LINES]});
    expect(realAnomalies(r)).toEqual([]);
    expect(r.events.filter(e => e.event.type === 'init_complete')).toHaveLength(1);
    expect(r.finalInventory).toEqual(BAG);
    expect(credited(r)).toEqual([]);
  });

  it('a marker with no dump after it leaves the engine initializing', async () => {
    const r = await run({source: [strayMarker(LINES[0].ts - 10_000), ...LINES]});
    const init = r.events.filter(e => e.event.type === 'init_complete');
    expect(init).toHaveLength(1);
    expect(init[0].at).toBeGreaterThan(LINES[0].ts);
    expect(r.finalInventory).toEqual(BAG);
    expect(credited(r)).toEqual([]);
  });
});

describe('BagState de-duplicates repeated slots', () => {
  const dump = [
    {pageId: 102, slotId: 1, itemId: 100, quantity: 5},
    {pageId: 102, slotId: 2, itemId: 100, quantity: 3},
  ];

  it('processResort counts a slot listed twice once', () => {
    const bag = new BagState();
    bag.init(dump);
    expect(bag.processResort([...dump, ...dump])).toEqual([]);
    expect(bag.getTotalForItem(100)).toBe(8);
  });

  it('init counts a slot listed twice once', () => {
    const bag = new BagState();
    bag.init([...dump, ...dump]);
    expect(bag.getTotalForItem(100)).toBe(8);
  });
});
