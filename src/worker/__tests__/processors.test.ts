import {describe, it, expect, beforeEach} from 'vitest';
import {BagProcessor} from '@/worker/processors/bag';
import {ZoneProcessor} from '@/worker/processors/zone';
import {LevelTypeProcessor} from '@/worker/processors/level-type';
import {PriceProcessor} from '@/worker/processors/price';
import {S13Processor} from '@/worker/processors/s13';
import {S12Processor} from '@/worker/processors/s12';
import {S9Processor} from '@/worker/processors/s9';
import {S7Processor} from '@/worker/processors/s7';
import {S14Processor} from '@/worker/processors/s14';
import {S10Processor} from '@/worker/processors/s10';
import {S11Processor} from '@/worker/processors/s11';
import {HuntingProcessor} from '@/worker/processors/hunting';
import {AfterlightProcessor} from '@/worker/processors/afterlight';

// ---------------------------------------------------------------------------
// Realistic log line templates
// ---------------------------------------------------------------------------

const ts = '[2026.01.25-12.34.56:789]';

const lines = {
  bagInit:    `${ts}TLLua: Display: [Game] BagMgr@:InitBagData PageId = 0 SlotId = 15 ConfigBaseId = 12345 Num = 50`,
  bagUpdate:  `${ts}TLLua: Display: [Game] BagMgr@:Modfy BagItem PageId = 0 SlotId = 15 ConfigBaseId = 12345 Num = 75`,
  bagRemove:  `${ts}TLLua: Display: [Game] BagMgr@:RemoveBagItem PageId = 0 SlotId = 15`,
  zoneToMap:  `PageApplyBase@ _UpdateGameEnd: LastSceneName = World'XZ_YuJinZhiXiBiNanSuo200' NextSceneName = World'/Game/Art/Maps/S5_Magma_Boss'`,
  zoneToTown: `PageApplyBase@ _UpdateGameEnd: LastSceneName = World'/Game/Art/Maps/S5_Magma_Boss' NextSceneName = World'XZ_YuJinZhiXiBiNanSuo200'`,
  levelType:  `[2026.01.25-12.34.56:789] PreloadLevelType = 11`,
  unrelated:  `${ts}LogNet: Browse: UNetDriver::TickDispatch: Very long time`,
};

// ---------------------------------------------------------------------------
// BagProcessor
// ---------------------------------------------------------------------------

describe('BagProcessor', () => {
  const proc = new BagProcessor();

  it('has correct name', () => {
    expect(proc.name).toBe('bag');
  });

  it('test() matches bag lines', () => {
    expect(proc.test(lines.bagInit)).toBe(true);
    expect(proc.test(lines.bagUpdate)).toBe(true);
    expect(proc.test(lines.bagRemove)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.zoneToMap)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses bag_init', () => {
    expect(proc.process(lines.bagInit)).toEqual({
      type: 'bag_init',
      pageId: 0,
      slotId: 15,
      itemId: 12345,
      quantity: 50,
    });
  });

  it('parses bag_update', () => {
    expect(proc.process(lines.bagUpdate)).toEqual({
      type: 'bag_update',
      pageId: 0,
      slotId: 15,
      itemId: 12345,
      quantity: 75,
    });
  });

  it('parses bag_remove', () => {
    expect(proc.process(lines.bagRemove)).toEqual({
      type: 'bag_remove',
      pageId: 0,
      slotId: 15,
    });
  });

  it('handles large numeric IDs', () => {
    const line = `${ts}TLLua: Display: [Game] BagMgr@:InitBagData PageId = 2 SlotId = 999 ConfigBaseId = 9876543 Num = 100000`;
    const result = proc.process(line);
    expect(result).toEqual({
      type: 'bag_init',
      pageId: 2,
      slotId: 999,
      itemId: 9876543,
      quantity: 100000,
    });
  });

  it('returns null for partial BagMgr line', () => {
    const line = `${ts}TLLua: Display: [Game] BagMgr@:SomeOtherAction`;
    expect(proc.test(line)).toBe(true); // test passes (includes BagMgr@:)
    expect(proc.process(line)).toBeNull(); // but no regex matches
  });
});

// ---------------------------------------------------------------------------
// ZoneProcessor
// ---------------------------------------------------------------------------

describe('ZoneProcessor', () => {
  const proc = new ZoneProcessor();

  it('has correct name', () => {
    expect(proc.name).toBe('zone');
  });

  it('test() matches zone lines', () => {
    expect(proc.test(lines.zoneToMap)).toBe(true);
    expect(proc.test(lines.zoneToTown)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses zone transition to map', () => {
    expect(proc.process(lines.zoneToMap)).toEqual({
      type: 'zone_transition',
      fromScene: 'XZ_YuJinZhiXiBiNanSuo200',
      toScene: '/Game/Art/Maps/S5_Magma_Boss',
    });
  });

  it('parses zone transition to town', () => {
    expect(proc.process(lines.zoneToTown)).toEqual({
      type: 'zone_transition',
      fromScene: '/Game/Art/Maps/S5_Magma_Boss',
      toScene: 'XZ_YuJinZhiXiBiNanSuo200',
    });
  });

  it('handles season map paths', () => {
    const line = `PageApplyBase@ _UpdateGameEnd: LastSceneName = World'/Game/Art/Season/S13_VorexDungeon' NextSceneName = World'/Game/Art/Maps/S5_Arena'`;
    const result = proc.process(line);
    expect(result).toEqual({
      type: 'zone_transition',
      fromScene: '/Game/Art/Season/S13_VorexDungeon',
      toScene: '/Game/Art/Maps/S5_Arena',
    });
  });
});

// ---------------------------------------------------------------------------
// LevelTypeProcessor
// ---------------------------------------------------------------------------

describe('LevelTypeProcessor', () => {
  const proc = new LevelTypeProcessor();

  it('has correct name', () => {
    expect(proc.name).toBe('level-type');
  });

  it('test() matches level type lines', () => {
    expect(proc.test(lines.levelType)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses level type', () => {
    expect(proc.process(lines.levelType)).toEqual({
      type: 'level_type',
      levelType: 11,
    });
  });

  it('parses different level types', () => {
    const line = 'PreloadLevelType = 5';
    expect(proc.process(line)).toEqual({type: 'level_type', levelType: 5});
  });
});

// ---------------------------------------------------------------------------
// PriceProcessor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Realistic fixtures — built from actual game log samples in test_price_patterns.py
//
// Real send format:
//   ----Socket SendMessage STT----XchgSearchPrice----SynId = 47737
//   [blank line]
//   +typ3 [77]
//   +1+params
//   | +refer [0]        ← always present; 0 means "no filter" (simple search)
//   | +key [4]
//   ----Socket SendMessage End----
//
// Real recv format:
//   ----Socket RecvMessage STT----XchgSearchPrice----SynId = 47737
//   [blank line]
//   +prices+1+currency [100300]      ← FE marker on same line as prices header
//   |      | +unitPrices+1 [3.407]
//   |      | |          +2 [3.505]
//   ...
//   ----Socket RecvMessage End----
// ---------------------------------------------------------------------------

function makeSendLines(synId: string, typ3: number, refer?: number): string[] {
  // refer=0 simulates a simple search (always present in real log, means no filter)
  // refer=N (non-zero) simulates a filtered/category search with a specific item ID
  const referValue = refer ?? 0;
  return [
    `[ts]GameLog: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = ${synId}`,
    '[ts]GameLog: Display: [Game]',
    `+typ3 [${typ3}]`,
    '+1+params',
    `| +refer [${referValue}]`,
    '| +key [4]',
    '[ts]GameLog: Display: [Game] ----Socket SendMessage End----',
  ];
}

function makeRecvLines(synId: string, prices: number[], hasFEMarker = true): string[] {
  const feHeader = hasFEMarker ? '+prices+1+currency [100300]' : '+prices+1';
  const unitPriceLines = prices.map((p, i) =>
    i === 0
      ? `|      | +unitPrices+1 [${p}]`
      : `|      | |          +${i + 1} [${p}]`,
  );
  return [
    `[ts]GameLog: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = ${synId}`,
    '[ts]GameLog: Display: [Game]',
    feHeader,
    ...unitPriceLines,
    '+errCode',
    '[ts]GameLog: Display: [Game] ----Socket RecvMessage End----',
  ];
}

function feedLines(proc: PriceProcessor, lines: string[]) {
  return lines.map(l => (proc.test(l) ? proc.process(l) : null));
}

describe('PriceProcessor', () => {
  let proc: PriceProcessor;

  beforeEach(() => {
    proc = new PriceProcessor(); // fresh stateful instance per test
  });

  it('has correct name', () => {
    expect(proc.name).toBe('price');
  });

  it('test() returns true for XchgSearchPrice header lines', () => {
    expect(proc.test('[ts] ----Socket SendMessage STT----XchgSearchPrice----SynId = 1')).toBe(true);
    expect(proc.test('[ts] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 1')).toBe(true);
  });

  it('test() returns false for unrelated lines when idle', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
    expect(proc.test('+prices+1+unitPrices+1 [20.0]')).toBe(false);
  });

  it('test() returns true for all continuation lines while buffering', () => {
    // Start buffering
    const header = '[ts] ----Socket SendMessage STT----XchgSearchPrice----SynId = 1';
    proc.test(header);
    proc.process(header);

    // Continuation lines with no XchgSearchPrice marker
    expect(proc.test('+typ3 [77]')).toBe(true);
    expect(proc.test(lines.bagInit)).toBe(true); // claimed even if bag-like
    expect(proc.test('Socket SendMessage End')).toBe(true);
  });

  it('returns null for all lines of a SendMessage (just records pending request)', () => {
    const results = feedLines(proc, makeSendLines('42', 1234));
    expect(results.every(r => r === null)).toBe(true);
  });

  it('returns price_update after matching Send then Recv (simple search — typ3 is item ID)', () => {
    feedLines(proc, makeSendLines('1', 5011));
    const results = feedLines(proc, makeRecvLines('1', [20, 21, 22]));
    const event = results.find(r => r !== null);
    expect(event).toEqual({type: 'price_update', itemId: 5011, price: 21}); // median of [20,21,22]
  });

  it('uses +refer as item ID for filtered (category) searches', () => {
    feedLines(proc, makeSendLines('2', 77, 9999)); // typ3=77 (category), refer=9999 (actual item)
    const results = feedLines(proc, makeRecvLines('2', [100]));
    const event = results.find(r => r !== null);
    expect(event).toMatchObject({type: 'price_update', itemId: 9999, price: 100});
  });

  it('rejects recv with no FE currency marker', () => {
    feedLines(proc, makeSendLines('3', 1001));
    const results = feedLines(proc, makeRecvLines('3', [50, 60], false)); // no +currency [100300]
    expect(results.every(r => r === null)).toBe(true);
  });

  it('ignores recv with no matching pending send', () => {
    // Feed recv without a prior send
    const results = feedLines(proc, makeRecvLines('99', [10]));
    expect(results.every(r => r === null)).toBe(true);
  });

  it('calculates median correctly for odd count', () => {
    feedLines(proc, makeSendLines('4', 1001));
    const results = feedLines(proc, makeRecvLines('4', [10, 20, 30]));
    const event = results.find(r => r !== null);
    expect(event).toMatchObject({price: 20});
  });

  it('calculates median correctly for even count', () => {
    feedLines(proc, makeSendLines('5', 1001));
    const results = feedLines(proc, makeRecvLines('5', [10, 20, 30, 40]));
    const event = results.find(r => r !== null);
    expect(event).toMatchObject({price: 25}); // (20+30)/2
  });

  it('calculates median correctly for single price', () => {
    feedLines(proc, makeSendLines('6', 1001));
    const results = feedLines(proc, makeRecvLines('6', [42.5]));
    const event = results.find(r => r !== null);
    expect(event).toMatchObject({price: 42.5});
  });

  it('handles multiple independent send/recv pairs in sequence', () => {
    // First pair
    feedLines(proc, makeSendLines('10', 1001));
    const r1 = feedLines(proc, makeRecvLines('10', [5]));
    expect(r1.find(r => r !== null)).toMatchObject({itemId: 1001, price: 5});

    // Second pair — processor state reset between messages
    feedLines(proc, makeSendLines('11', 2002));
    const r2 = feedLines(proc, makeRecvLines('11', [8]));
    expect(r2.find(r => r !== null)).toMatchObject({itemId: 2002, price: 8});
  });

  it('aborts and resets on buffer overflow (>200 lines)', () => {
    // Start a message but never send end marker — force overflow
    const header = '[ts] ----Socket SendMessage STT----XchgSearchPrice----SynId = 20';
    proc.test(header);
    proc.process(header);

    // Feed 200 more lines without end marker
    for (let i = 0; i < 200; i++) {
      const line = `+junk [${i}]`;
      proc.test(line);
      proc.process(line);
    }

    // Processor should now be idle (not buffering)
    // A new unrelated line should return false from test()
    expect(proc.test(lines.unrelated)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S13Processor (Vorex)
// ---------------------------------------------------------------------------

const ts13 = '[2026.01.25-12.34.56:789]';

const s13Lines = {
  start:       `${ts13} S13GamePlayMain Run`,
  windowClose: `${ts13} S13GamePlayMain::Destory`,
  abandon:     `${ts13} S13GamePlay Destory`,
  unrelated:   `${ts13} SomeOtherSystem S13GamePlaySomethingElse`,
};

describe('S13Processor', () => {
  const proc = new S13Processor();

  it('has correct name', () => {
    expect(proc.name).toBe('s13');
  });

  it('test() matches all S13GamePlay lines', () => {
    expect(proc.test(s13Lines.start)).toBe(true);
    expect(proc.test(s13Lines.windowClose)).toBe(true);
    expect(proc.test(s13Lines.abandon)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.zoneToMap)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses s13_start', () => {
    expect(proc.process(s13Lines.start)).toEqual({type: 's13_start'});
  });

  it('parses s13_window_close', () => {
    expect(proc.process(s13Lines.windowClose)).toEqual({type: 's13_window_close'});
  });

  it('parses s13_abandon', () => {
    expect(proc.process(s13Lines.abandon)).toEqual({type: 's13_abandon'});
  });

  it('window_close takes priority over abandon (both contain "S13GamePlay Destory")', () => {
    // "S13GamePlayMain::Destory" contains "S13GamePlay" AND could match abandon pattern
    // window_close must win because it's checked first
    expect(proc.process(s13Lines.windowClose)).toEqual({type: 's13_window_close'});
    expect(proc.process(s13Lines.abandon)).toEqual({type: 's13_abandon'});
  });

  it('returns null for unrecognised S13GamePlay line', () => {
    expect(proc.process(s13Lines.unrelated)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S9Processor (Arcana — Tarot / Fateful Contest)
// ---------------------------------------------------------------------------

const ts9 = '[2026.01.25-12.34.56:789]';

const s9Lines = {
  minigame:  `${ts9}TLLua: Display: [Game] S9Taro Run`,
  fight:     `${ts9}TLLua: Display: [Game] S9Challenge Run`,
  hide:      `${ts9}TLLua: Display: [Game] S9Taro Hide`,
  destroy:   `${ts9}TLLua: Display: [Game] S9Taro Destory`,
  chalEnd:   `${ts9}TLLua: Display: [Game] S9Challenge Destory`,
  close:     `${ts9}TLLua: Display: [Game] PageApplyBase@ OnPageBackEvent FuncId = 41700_S9TaroCtrl`,
};

describe('S9Processor', () => {
  const proc = new S9Processor();

  it('has correct name', () => {
    expect(proc.name).toBe('s9');
  });

  it('test() matches S9Taro and S9Challenge lines', () => {
    expect(proc.test(s9Lines.minigame)).toBe(true);
    expect(proc.test(s9Lines.fight)).toBe(true);
    expect(proc.test(s9Lines.hide)).toBe(true);
    expect(proc.test(s9Lines.chalEnd)).toBe(true);
    expect(proc.test(s9Lines.close)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.zoneToMap)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses s9_minigame from S9Taro Run', () => {
    expect(proc.process(s9Lines.minigame)).toEqual({type: 's9_minigame'});
  });

  it('parses s9_fight from S9Challenge Run', () => {
    expect(proc.process(s9Lines.fight)).toEqual({type: 's9_fight'});
  });

  it('ignores S9Taro Hide (teardown)', () => {
    expect(proc.process(s9Lines.hide)).toBeNull();
  });

  it('ignores S9Taro Destory (teardown, both commit & abandon)', () => {
    expect(proc.process(s9Lines.destroy)).toBeNull();
  });

  it('ignores S9Challenge Destory (scene-load teardown)', () => {
    expect(proc.process(s9Lines.chalEnd)).toBeNull();
  });

  it('parses s9_close from the Tarot panel back-event', () => {
    expect(proc.process(s9Lines.close)).toEqual({type: 's9_close'});
  });

  it('does not treat OnPageBackEvent for other pages as s9_close', () => {
    const otherPage = `${ts9}TLLua: Display: [Game] PageApplyBase@ OnPageBackEvent FuncId = 12345_SomeOtherCtrl`;
    expect(proc.process(otherPage)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S12Processor (Overrealm)
// ---------------------------------------------------------------------------

const s12Lines = {
  // LevelType 25 = Overrealm pact. The LevelMgr@ line fires when the player
  // loads into it (real entry signal).
  entry:        '[2026.01.25-12.34.56:789]TLShipping: Display: [Game] LevelMgr@ LevelUid, LevelType, LevelId = 1121406 25 5354',
  // LevelType 3 = regular Netherrealm map. Fires on exit from Overrealm too —
  // but we don't act on it (death/abandon handled via town entry).
  levelTypeMap: '[2026.01.25-12.34.56:789]TLShipping: Display: [Game] LevelMgr@ LevelUid, LevelType, LevelId = 1121406 3 5354',
  // notifyId 101 = Overrealm completed successfully, arm the loot timer.
  exit:         '[2026.01.25-12.34.56:789]TLGame: Display: [Game] gameplay type 8001 received notifyId 101 NotifyData ',
  // notifyId 102/103/104 fire during a run but are not the exit signal.
  notifyOther:  '[2026.01.25-12.34.56:789]TLGame: Display: [Game] gameplay type 8001 received notifyId 104 NotifyData ',
  // The S12SwitchFinish line is no longer trusted — fires on both directions
  // of the visual switch. The processor must NOT react to it.
  legacySwitch: '[2026.01.25-12.34.56:789]TLGame: Display: [Game] USceneEffectMgr::S12SwitchFinish success.',
};

describe('S12Processor', () => {
  const proc = new S12Processor();

  it('has correct name', () => {
    expect(proc.name).toBe('s12');
  });

  it('test() matches LevelType-25 entry lines', () => {
    expect(proc.test(s12Lines.entry)).toBe(true);
  });

  it('test() matches the notifyId 101 exit line', () => {
    expect(proc.test(s12Lines.exit)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
    expect(proc.test(s12Lines.notifyOther)).toBe(false);
    expect(proc.test(s12Lines.legacySwitch)).toBe(false);
    expect(proc.test(s12Lines.levelTypeMap)).toBe(false); // regular-map LevelType 3
  });

  it('emits s12_entry when LevelType 25 is loaded', () => {
    expect(proc.process(s12Lines.entry)).toEqual({type: 's12_entry'});
  });

  it('emits s12_exit on the notifyId 101 completion signal', () => {
    expect(proc.process(s12Lines.exit)).toEqual({type: 's12_exit'});
  });

  it('ignores LevelType-3 transitions back to the regular map', () => {
    // Death/abandon AND successful exit both produce a LevelType 3 line.
    // The processor must not act on it — successful exits surface via
    // notifyId 101; death/abandon flows through town entry.
    expect(proc.process(s12Lines.levelTypeMap)).toBeNull();
  });

  it('ignores legacy USceneEffectMgr::S12SwitchFinish lines (fires on both directions)', () => {
    expect(proc.process(s12Lines.legacySwitch)).toBeNull();
  });

  it('ignores other notifyId values that fire during a run', () => {
    expect(proc.process(s12Lines.notifyOther)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S7Processor (Clockwork Ballet)
// ---------------------------------------------------------------------------

const ts7 = '[2026.04.22-15.19.40:581]';

const s7Lines = {
  podium:       `${ts7}TLLua: Display: [Game] AudioMgr@PlayAudio  AudioEnum  == S7_3X1_Open`,
  cogwheel:     `${ts7}[476]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_S7_WOJLB_Machine_Gear_Idle_Common_Lp' requested row 'Play_Obj_S7_WOJLB_Machine_Gear_Idle_Common_Lp' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  cogwheelEnd:  `${ts7}[476]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_S7_WOJLB_Machine_Gear_Exp_Common' requested row 'Play_Obj_S7_WOJLB_Machine_Gear_Exp_Common' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  rewardBox:    `${ts7}[476]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_S7_WOJLB_Machine_GearBox_Appear_Common' requested row 'Play_Obj_S7_WOJLB_Machine_GearBox_Appear_Common' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  cogwheelMob:  `${ts7}TLGame: Display: [Game] Monster Created: npc id 2610011 rarity 1`,
  voucher:      `${ts7}TLLua: Display: [Game] AudioMgr@PlayAudio  AudioEnum  == S7_Level_Gear`,
  turnin:       `${ts7}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = S7GamePlayStateStart PushState = S7GamePlayStateSuccess`,
  gameStart:    `${ts7}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = -1 PushState = S7GamePlayStateStart`,
  heartbeat:    `${ts7}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = S7GamePlayStateStart PushState = S7GamePlayStateStart`,
  failOpen:     `${ts7}TLLua: Display: [Game] PageBase@ OpenFlow0! Switch = true S7GamePlayFailStateItem 8292819`,
  failOther:    `${ts7}TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = S7GamePlayFailStateItem , PageRunState = Run`,
  podiumEcho:   `${ts7}LogDataTable: Warning: UDataTable::FindRow : 'Play_UI_S7_3X1_Open' requested row 'Play_UI_S7_3X1_Open' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  otherAudio:   `${ts7}TLLua: Display: [Game] AudioMgr@PlayAudio  AudioEnum  == S7_Rating_SSS`,
  otherMob:     `${ts7}TLGame: Display: [Game] Monster Created: npc id 1170005 rarity 1`,
};

describe('S7Processor', () => {
  const proc = new S7Processor();

  it('has correct name', () => {
    expect(proc.name).toBe('s7');
  });

  it('test() matches audio, machine, push-data and fail-page lines', () => {
    expect(proc.test(s7Lines.podium)).toBe(true);
    expect(proc.test(s7Lines.cogwheel)).toBe(true);
    expect(proc.test(s7Lines.cogwheelEnd)).toBe(true);
    expect(proc.test(s7Lines.turnin)).toBe(true);
    expect(proc.test(s7Lines.heartbeat)).toBe(true);
    expect(proc.test(s7Lines.failOpen)).toBe(true);
    expect(proc.test(s7Lines.failOther)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses s7_podium from the modifier-podium open', () => {
    expect(proc.process(s7Lines.podium)).toEqual({type: 's7_podium'});
  });

  it('parses a spinning cogwheel and its explosion as distinct events', () => {
    expect(proc.process(s7Lines.cogwheel)).toEqual({type: 's7_cogwheel'});
    expect(proc.process(s7Lines.cogwheelEnd)).toEqual({type: 's7_cogwheel_end'});
  });

  // The cogwheel's mobs scatter across the whole map, so kills made anywhere
  // would keep re-arming the window — measured 1.45x over-counted fight time.
  it('ignores cogwheel MOB spawns — the machine is the activity signal', () => {
    expect(proc.process(s7Lines.cogwheelMob)).toBeNull();
    expect(proc.process(s7Lines.otherMob)).toBeNull();
  });

  it('ignores the post-turn-in reward chest markers', () => {
    expect(proc.process(s7Lines.rewardBox)).toBeNull();
  });

  // It trails Gear_Exp by ~0.15s so adds nothing, and 38 of 164 fire with no
  // cogwheel at all (bonus and turn-in payouts) — acting on those would park
  // the tracker mid-run.
  it('ignores the voucher award — the explosion is the end marker', () => {
    expect(proc.process(s7Lines.voucher)).toBeNull();
  });

  it('ignores the LogDataTable echo of an audio marker', () => {
    expect(proc.process(s7Lines.podiumEcho)).toBeNull();
  });

  it('ignores audio markers we do not track', () => {
    expect(proc.process(s7Lines.otherAudio)).toBeNull();
  });

  it('parses s7_turnin from the Success push', () => {
    expect(proc.process(s7Lines.turnin)).toEqual({type: 's7_turnin'});
  });

  it('parses s7_fail only from the OpenFlow0 fail-page line', () => {
    expect(proc.process(s7Lines.failOpen)).toEqual({type: 's7_fail'});
    expect(proc.process(s7Lines.failOther)).toBeNull();
  });

  it('ignores heartbeat pings and the -1 → Start transition', () => {
    expect(proc.process(s7Lines.heartbeat)).toBeNull();
    expect(proc.process(s7Lines.gameStart)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S14Processor (Lunaria — MingYue)
// ---------------------------------------------------------------------------

const ts14 = '[2026.05.07-14.29.35:474]';

const s14Lines = {
  strum:    `${ts14}TLGame: Display: [Game] UECtrlComponent@ DoAction S14GameplayStart`,
  // Lines that should be ignored — strum is the only signal we listen for:
  bgmStart:    `${ts14}TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S14_Gameplay_MusicEvents/Play_Mus_Gameplay_S14_Basic.Play_Mus_Gameplay_S14_Basic id 15995`,
  bgmStop:     `${ts14}TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S14_Gameplay_MusicEvents/Stop_Mus_Gameplay_S14_Basic id 18592`,
  chargeAnim:  `${ts14}TLLua: Display: [Game] 3439_S14HomeBtn ChargeAnim Start`,
  assetLoad:   `${ts14}TLShipping: Display: [Game] AssetLoad@ AsyncLoadRequest! PathStr = UI_MiniMap_S14Statue1' LoadingNum = 1046`,
};

describe('S14Processor', () => {
  const proc = new S14Processor();

  it('has correct name', () => {
    expect(proc.name).toBe('s14');
  });

  it('test() matches strum lines', () => {
    expect(proc.test(s14Lines.strum)).toBe(true);
  });

  it('test() rejects everything else (BGM start/stop, charge anim, asset loads, unrelated)', () => {
    // All these contain "S14" but the handler only cares about strum — the
    // pausing loot timer drives episode boundaries instead.
    expect(proc.test(s14Lines.bgmStart)).toBe(false);
    expect(proc.test(s14Lines.bgmStop)).toBe(false);
    expect(proc.test(s14Lines.chargeAnim)).toBe(false);
    expect(proc.test(s14Lines.assetLoad)).toBe(false);
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses s14_strum from S14GameplayStart action', () => {
    expect(proc.process(s14Lines.strum)).toEqual({type: 's14_strum'});
  });
});

// ---------------------------------------------------------------------------
// S10Processor (Sandlord — in-map coin tile)
// ---------------------------------------------------------------------------

const ts10 = '[2026.08.09-08.33.32:619][249]';

/** Every S10 tile marker surfaces as the same missing-DataTable warning. */
function s10Line(marker: string): string {
  return `${ts10}LogDataTable: Warning: UDataTable::FindRow : '${marker}' requested row '${marker}' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`;
}

const s10Lines = {
  tile:           s10Line('Play_Obj_Season_S10_Machine_Normal_Lp'),
  wavePaLu:       s10Line('Play_Obj_Season_S10_Machine_PaLu_Active_Lp'),
  waveResource:   s10Line('Play_Obj_Season_S10_Machine_Resource_Active_Lp'),
  quenchPaLu:     s10Line('Play_Obj_Season_S10_Machine_PaLu_Quench'),
  quenchResource: s10Line('Play_Obj_Season_S10_Machine_Resource_Quench'),
  // Mob-landing markers — the per-round wave signal (a Machine_*_Active fires
  // only once per machine, so landings are what attest further rounds).
  landWuZhuangZhe: s10Line('Play_Obj_Season_S10_WuZhuangZhe_Land'),
  landLieRen:      s10Line('Play_Obj_Season_S10_LieRen_Land'),
  // Coin-drop FX under the same prefix — matched by test() but not an event.
  dropBall: s10Line('Play_Obj_Season_S10_DropBall_Shoot'),
};

describe('S10Processor', () => {
  const proc = new S10Processor();

  it('has correct name', () => {
    expect(proc.name).toBe('s10');
  });

  it('test() matches every Machine and mob-landing marker', () => {
    expect(proc.test(s10Lines.tile)).toBe(true);
    expect(proc.test(s10Lines.wavePaLu)).toBe(true);
    expect(proc.test(s10Lines.waveResource)).toBe(true);
    expect(proc.test(s10Lines.quenchPaLu)).toBe(true);
    expect(proc.test(s10Lines.quenchResource)).toBe(true);
    expect(proc.test(s10Lines.landWuZhuangZhe)).toBe(true);
    expect(proc.test(s10Lines.landLieRen)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.zoneToMap)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('ignores the Normal_Lp proximity loop', () => {
    // The tile's idle ambient loop starts when the tile renders near the player,
    // up to 43.8s before the real activation — starting on it credited the walk-up.
    expect(proc.process(s10Lines.tile)).toBeNull();
  });

  it('parses s10_wave from both Active_Lp variants', () => {
    expect(proc.process(s10Lines.wavePaLu)).toEqual({type: 's10_wave'});
    expect(proc.process(s10Lines.waveResource)).toEqual({type: 's10_wave'});
  });

  it('parses s10_wave from mob-landing markers', () => {
    expect(proc.process(s10Lines.landWuZhuangZhe)).toEqual({type: 's10_wave'});
    expect(proc.process(s10Lines.landLieRen)).toEqual({type: 's10_wave'});
  });

  it('returns null for non-marker S10 audio under the same prefix', () => {
    expect(proc.process(s10Lines.dropBall)).toBeNull();
  });

  it('parses s10_quench from both Quench variants', () => {
    // The variant mirrors whichever Active marker fired last — not a
    // success/fail distinction, so both map to the same event.
    expect(proc.process(s10Lines.quenchPaLu)).toEqual({type: 's10_quench'});
    expect(proc.process(s10Lines.quenchResource)).toEqual({type: 's10_quench'});
  });

  it('returns null for an unrecognised Machine marker', () => {
    expect(proc.process(s10Line('Play_Obj_Season_S10_Machine_Something_Else'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HuntingProcessor (SixGod — statue + boss arena)
// ---------------------------------------------------------------------------

const tsHunt = '[2026.08.09-08.33.32:619]';

const huntingLines = {
  statue:    `${tsHunt}TLLua: Display: [Game] FightMgr:OnGatherEnd logicEtyId 11 cfgId 20004 altlasId -1`,
  bossStart: `${tsHunt}TLLua: Display: [Game] FightHunting BossStatus1`,
  bossEnd:   `${tsHunt}TLLua: Display: [Game] FightHunting BossStatus0`,
  // A different gatherable — same marker, wrong cfgId.
  otherGather: `${tsHunt}TLLua: Display: [Game] FightMgr:OnGatherEnd logicEtyId 22561 cfgId 22201 altlasId 0`,
  // Same "SixGod" family, deliberately not keyed on: audio-enum lines.
  huntAudio: `${tsHunt}TLLua: Display: [Game] AudioMgr@PlayAudio  AudioEnum  == SixGod_Hunt_GameStart`,
  warAudio:  `${tsHunt}TLLua: Display: [Game] AudioMgr@PlayAudio  AudioEnum  == SixGod_War_GameStart`,
};

describe('HuntingProcessor', () => {
  const proc = new HuntingProcessor();

  it('has correct name', () => {
    expect(proc.name).toBe('hunting');
  });

  it('test() matches statue and boss-status lines', () => {
    expect(proc.test(huntingLines.statue)).toBe(true);
    expect(proc.test(huntingLines.bossStart)).toBe(true);
    expect(proc.test(huntingLines.bossEnd)).toBe(true);
  });

  it('test() rejects the SixGod audio-enum lines outright', () => {
    // The mechanic is keyed on FightHunting/cfgId; SixGod_War is a different
    // mechanic in the same family and must never reach process().
    expect(proc.test(huntingLines.huntAudio)).toBe(false);
    expect(proc.test(huntingLines.warAudio)).toBe(false);
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses hunting_statue from the cfgId 20004 gather', () => {
    expect(proc.process(huntingLines.statue)).toEqual({type: 'hunting_statue'});
  });

  it('parses hunting_boss_start from BossStatus1', () => {
    expect(proc.process(huntingLines.bossStart)).toEqual({type: 'hunting_boss_start'});
  });

  it('parses hunting_boss_end from BossStatus0', () => {
    expect(proc.process(huntingLines.bossEnd)).toEqual({type: 'hunting_boss_end'});
  });

  it('ignores gathers of other interactables (different cfgId)', () => {
    expect(proc.process(huntingLines.otherGather)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S11Processor (Carjack — in-map Robbery encounter)
// ---------------------------------------------------------------------------

const tsS11 = '[2026.08.10-06.01.36:269][665]';

/** The THTJ combat markers surface as missing-DataTable warnings. */
function s11ObjLine(marker: string): string {
  return `${tsS11}LogDataTable: Warning: UDataTable::FindRow : '${marker}' requested row '${marker}' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`;
}

const s11Lines = {
  start: `${tsS11}TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S11_Gameplay_MusicEvents/Play_Mus_Gameplay_S11_Robbery_Full.Play_Mus_Gameplay_S11_Robbery_Full id 68451`,
  end:   `${tsS11}TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S11_Gameplay_MusicEvents/Stop_Mus_Gameplay_S11_Robbery_Full.Stop_Mus_Gameplay_S11_Robbery_Full id 73296`,
  monAppear:   s11ObjLine('Play_Obj_Season_S11_THTJ_Mon_Appear'),
  monDie:      s11ObjLine('Play_Obj_Season_S11_THTJ_Mon_Die_Gold2'),
  boxOpen:     s11ObjLine('Play_Obj_Season_S11_THTJ_BoxMonster_Open'),
  carOpen:     s11ObjLine('Play_Obj_Season_S11_THTJ_Car_Open1'),
  monDisAppear: s11ObjLine('Play_Obj_Season_S11_THTJ_Mon_DisAppear'),
  uiCountdown: `${tsS11}TLGame: Display: [Game] AudioMgr@PlayAudio Play_UI_Season_S11_THTJ_YJ_Count_Down`,
};

describe('S11Processor', () => {
  const proc = new S11Processor();

  it('has correct name', () => {
    expect(proc.name).toBe('s11');
  });

  it('test() matches both the music and the combat markers', () => {
    expect(proc.test(s11Lines.start)).toBe(true);
    expect(proc.test(s11Lines.end)).toBe(true);
    // Regression: test() used to gate on the music string alone, so the THTJ
    // combat markers never reached process() at all.
    expect(proc.test(s11Lines.monDie)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses s11_start and s11_end from the music markers', () => {
    // Stop must be checked first — its string contains the Play marker.
    expect(proc.process(s11Lines.start)).toEqual({type: 's11_start'});
    expect(proc.process(s11Lines.end)).toEqual({type: 's11_end'});
  });

  it('parses s11_wave from mob, box and car markers', () => {
    expect(proc.process(s11Lines.monAppear)).toEqual({type: 's11_wave'});
    expect(proc.process(s11Lines.monDie)).toEqual({type: 's11_wave'});
    expect(proc.process(s11Lines.boxOpen)).toEqual({type: 's11_wave'});
    expect(proc.process(s11Lines.carOpen)).toEqual({type: 's11_wave'});
  });

  it('returns null for the terminal despawn burst', () => {
    // Mon_DisAppear fires as the encounter ends, so counting it as activity
    // would extend the window exactly when it should expire.
    expect(proc.process(s11Lines.monDisAppear)).toBeNull();
  });

  it('ignores the UI flourish markers', () => {
    expect(proc.test(s11Lines.uiCountdown)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AfterlightProcessor (S15 ShouYe — in-map cart encounter)
// ---------------------------------------------------------------------------

const tsAfter = '[2026.08.10-05.51.03:061][835]';

/** Every ShouYe marker surfaces as the same missing-DataTable warning. */
function afterlightLine(marker: string): string {
  return `${tsAfter}LogDataTable: Warning: UDataTable::FindRow : '${marker}' requested row '${marker}' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`;
}

const afterlightLines = {
  wardenApp:  afterlightLine('Play_Obj_Season_S15_ShouYe_JiangJun_App'),
  wardenWin:  afterlightLine('Play_Obj_Season_S15_ShouYe_JiangJun_Win'),
  brideApp:   afterlightLine('Play_Obj_Season_S15_ShouYe_XinNiang_App'),
  brideWin:   afterlightLine('Play_Obj_Season_S15_ShouYe_XinNiang_Win'),
  // Non-encounters sharing the prefix: the ghost is a mid-fight NPC and the box
  // a reward chest. Neither ever has a _Win, so neither may trigger.
  ghostApp:    afterlightLine('Play_Obj_Season_S15_ShouYe_YouHun_App'),
  ghostDiaApp: afterlightLine('Play_Obj_Season_S15_ShouYe_YouHun_DiaApp'),
  boxApp:      afterlightLine('Play_Obj_Season_S15_ShouYe_Box_App'),
  boxOpen:     afterlightLine('Play_Obj_Season_S15_ShouYe_Box_Open'),
  flowerPick:  afterlightLine('Play_Obj_Season_S15_ShouYe_XinNiang_Flower_Pick'),
  wardenLose:  afterlightLine('Play_Obj_Season_S15_ShouYe_JiangJun_Lose'),
  // Waves are a gameplay line, not an audio row. 299-prefixed npc ids fire only
  // inside an Afterlight encounter; the 2991xxx family appears in some sessions.
  wave:        `${tsAfter}TLGame: Display: [Game] Monster Created: npc id 2990103 rarity 1`,
  waveAlt:     `${tsAfter}TLGame: Display: [Game] Monster Created: npc id 2991002 rarity 2`,
  genericMob:  `${tsAfter}TLGame: Display: [Game] Monster Created: npc id 1140043 rarity 1`,
};

describe('AfterlightProcessor', () => {
  const proc = new AfterlightProcessor();

  it('has correct name', () => {
    expect(proc.name).toBe('afterlight');
  });

  it('test() matches every ShouYe marker', () => {
    expect(proc.test(afterlightLines.wardenApp)).toBe(true);
    expect(proc.test(afterlightLines.wardenWin)).toBe(true);
    expect(proc.test(afterlightLines.brideApp)).toBe(true);
    expect(proc.test(afterlightLines.ghostApp)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.zoneToMap)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses afterlight_start from both encounter variants', () => {
    expect(proc.process(afterlightLines.wardenApp)).toEqual({type: 'afterlight_start'});
    expect(proc.process(afterlightLines.brideApp)).toEqual({type: 'afterlight_start'});
  });

  it('parses afterlight_end from both encounter variants', () => {
    expect(proc.process(afterlightLines.wardenWin)).toEqual({type: 'afterlight_end'});
    expect(proc.process(afterlightLines.brideWin)).toEqual({type: 'afterlight_end'});
  });

  it('parses afterlight_end from a failed encounter', () => {
    expect(proc.process(afterlightLines.wardenLose)).toEqual({type: 'afterlight_end'});
  });

  it('parses afterlight_wave from 299-prefixed mob spawns', () => {
    expect(proc.test(afterlightLines.wave)).toBe(true);
    expect(proc.process(afterlightLines.wave)).toEqual({type: 'afterlight_wave'});
    expect(proc.process(afterlightLines.waveAlt)).toEqual({type: 'afterlight_wave'});
  });

  it('ignores generic map mobs sharing the Monster Created line shape', () => {
    expect(proc.test(afterlightLines.genericMob)).toBe(false);
  });

  it('maps the non-Core BGM brackets to special / end', () => {
    const mus = (m: string) =>
      `${tsAfter}TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S15_Gameplay_MusicEvents/${m}.${m} id 1`;

    for (const kind of ['Special', 'Bride', 'Goblin']) {
      expect(proc.process(mus(`Play_Mus_Gameplay_S15_${kind}`))).toEqual({type: 'afterlight_special'});
      // Stop is checked first — its string contains the Play marker.
      expect(proc.process(mus(`Stop_Mus_Gameplay_S15_${kind}`))).toEqual({type: 'afterlight_end'});
    }
  });

  it('ignores the Core BGM — the plain fight uses its boss rows', () => {
    const mus = (m: string) =>
      `${tsAfter}TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S15_Gameplay_MusicEvents/${m}.${m} id 1`;
    expect(proc.process(mus('Play_Mus_Gameplay_S15_Core'))).toBeNull();
    expect(proc.process(mus('Stop_Mus_Gameplay_S15_Core'))).toBeNull();
  });

  it('returns null for the wandering ghost', () => {
    // It fires *inside* a running encounter, so treating its _App as a start
    // would spawn a phantom second tracker mid-fight.
    expect(proc.process(afterlightLines.ghostApp)).toBeNull();
    expect(proc.process(afterlightLines.ghostDiaApp)).toBeNull();
  });

  it('returns null for the reward chest', () => {
    expect(proc.process(afterlightLines.boxApp)).toBeNull();
    expect(proc.process(afterlightLines.boxOpen)).toBeNull();
  });

  it('returns null for the Bride flower pickups', () => {
    // Shares the XinNiang prefix but is neither an _App nor a _Win.
    expect(proc.process(afterlightLines.flowerPick)).toBeNull();
  });

  it('returns null for an unrecognised ShouYe marker', () => {
    expect(proc.process(afterlightLine('Play_Obj_Season_S15_ShouYe_Something_Else'))).toBeNull();
  });
});
