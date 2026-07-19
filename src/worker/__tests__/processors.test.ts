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
  start:     `${ts7}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = -1 PushState = S7GamePlayStateStart`,
  heartbeat: `${ts7}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = S7GamePlayStateStart PushState = S7GamePlayStateStart`,
  success:   `${ts7}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = S7GamePlayStateStart PushState = S7GamePlayStateSuccess`,
  failOpen:  `${ts7}TLLua: Display: [Game] PageBase@ OpenFlow0! Switch = true S7GamePlayFailStateItem 8292819`,
  failOther: `${ts7}TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = S7GamePlayFailStateItem , PageRunState = Run`,
};

describe('S7Processor', () => {
  const proc = new S7Processor();

  it('has correct name', () => {
    expect(proc.name).toBe('s7');
  });

  it('test() matches push-data and fail-page lines', () => {
    expect(proc.test(s7Lines.start)).toBe(true);
    expect(proc.test(s7Lines.heartbeat)).toBe(true);
    expect(proc.test(s7Lines.success)).toBe(true);
    expect(proc.test(s7Lines.failOpen)).toBe(true);
    expect(proc.test(s7Lines.failOther)).toBe(true);
  });

  it('test() rejects unrelated lines', () => {
    expect(proc.test(lines.bagInit)).toBe(false);
    expect(proc.test(lines.unrelated)).toBe(false);
  });

  it('parses s7_start from -1 → Start transition', () => {
    expect(proc.process(s7Lines.start)).toEqual({type: 's7_start'});
  });

  it('parses s7_success from Start → Success transition', () => {
    expect(proc.process(s7Lines.success)).toEqual({type: 's7_success'});
  });

  it('parses s7_fail only from the OpenFlow0 fail-page line', () => {
    expect(proc.process(s7Lines.failOpen)).toEqual({type: 's7_fail'});
    expect(proc.process(s7Lines.failOther)).toBeNull();
  });

  it('ignores heartbeat pings (Start → Start)', () => {
    expect(proc.process(s7Lines.heartbeat)).toBeNull();
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
