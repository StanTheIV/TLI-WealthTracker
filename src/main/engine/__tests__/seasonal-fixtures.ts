/**
 * Shared fixtures for seasonal mechanic integration tests.
 *
 * Each `seasonal-*.test.ts` file imports from here. Keeps the realistic log
 * line strings, scene constants, dispatcher/engine factories, and assertion
 * helpers in one place so they don't drift across the per-mechanic files.
 *
 * Filename has no `.test.ts` suffix on purpose — vitest only picks up
 * `*.test.ts` per the project's vitest.config.ts include glob.
 */
import {vi} from 'vitest';
import type {Dispatcher} from '@/worker/dispatcher';
import {createDispatcher as createProductionDispatcher} from '@/worker/create-dispatcher';
import type {Engine} from '@/main/engine/engine';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {OverrealmHandler} from '@/main/engine/handlers/overrealm-handler';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

// ---------------------------------------------------------------------------
// Realistic log line fixtures — copied from actual game log format
// ---------------------------------------------------------------------------

const ts = '[2026.01.25-12.34.56:789]';

export const log = {
  bagInit:  (slotId: number, itemId: number, qty: number) =>
    `${ts}TLLua: Display: [Game] BagMgr@:InitBagData PageId = 0 SlotId = ${slotId} ConfigBaseId = ${itemId} Num = ${qty}`,

  bagUpdate: (slotId: number, itemId: number, qty: number) =>
    `${ts}TLLua: Display: [Game] BagMgr@:Modfy BagItem PageId = 0 SlotId = ${slotId} ConfigBaseId = ${itemId} Num = ${qty}`,

  bagRemove: (slotId: number) =>
    `${ts}TLLua: Display: [Game] BagMgr@:RemoveBagItem PageId = 0 SlotId = ${slotId}`,

  zoneTransition: (from: string, to: string) =>
    `PageApplyBase@ _UpdateGameEnd: LastSceneName = World'${from}' NextSceneName = World'${to}'`,

  levelType: (n: number) =>
    `${ts} PreloadLevelType = ${n}`,

  s13Start:       `${ts} S13GamePlayMain Run`,
  s13WindowClose: `${ts} S13GamePlayMain::Destory`,
  s13Abandon:     `${ts} S13GamePlay Destory`,

  // Overrealm entry = LevelType 25 transition; exit = notifyId 101 success.
  // Tartarus (S16). Every device open first replays the previous settled
  // board's checkout (IsSettled=true) — dismissed with the same Ignore button.
  s16BoardOpen:        `${ts}TLLua: Display: [Game] [S16BGM] board Begin runId=cbd0465f-c985-11f1-858f-000000000137 IsSettled=false Result=-1`,
  s16BoardOpenSettled: `${ts}TLLua: Display: [Game] [S16BGM] board Begin runId=cbd0465f-c985-11f1-858f-000000000137 IsSettled=true Result=table: 000001E14F35A3A0`,
  s16BoardClose:       `${ts}TLLua: Display: [Game] S16BoardMain Destory`,
  s16Suppress:         `${ts}TLGame: Display: [Game] UIButton@ normal-click Btn_S16GamePlay_CheckOut_StartChallenge`,
  s16Ignore:           `${ts}TLGame: Display: [Game] UIButton@ normal-click Btn_S16GamePlay_CheckOut_AbandonChallenge`,
  // Sibling lines that fire alongside the real markers and must stay inert.
  s16BoardCloseTip:    `${ts}TLLua: Display: [Game] TipMsgShowMgr@DispatchPageRunChange PageName = S16BoardMain , PageRunState = Destory `,
  s16SuppressRow:      `${ts}[640]LogDataTable: Warning: UDataTable::FindRow : 'AudioMgr' requested row 'S16GamePlayCheckOut_C_Btn_S16GamePlay_CheckOut_StartChallenge' not in DataTable '/Game/Audio/BluePrint/AudioMgr.AudioMgr'.`,

  s12Entry:     `${ts}TLShipping: Display: [Game] LevelMgr@ LevelUid, LevelType, LevelId = 1121406 25 5354`,
  s12Exit:        `${ts}TLGame: Display: [Game] gameplay type 8001 received notifyId 101 NotifyData `,

  s11Start: `${ts}GameLog: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S11_Gameplay_MusicEvents/Play_Mus_Gameplay_S11_Robbery_Full.Play_Mus_Gameplay_S11_Robbery_Full id 3808`,
  s11End:   `${ts}GameLog: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S11_Gameplay_MusicEvents/Stop_Mus_Gameplay_S11_Robbery_Full.Stop_Mus_Gameplay_S11_Robbery_Full id 10149`,

  // Carjack combat activity — a mob kill. The Play_UI_Season_S11_THTJ_* siblings
  // are UI flourishes that fire outside combat and must not count as activity.
  s11Wave:    `${ts}[797]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S11_THTJ_Mon_Die_Gold2' requested row 'Play_Obj_Season_S11_THTJ_Mon_Die_Gold2' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  s11Despawn: `${ts}[797]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S11_THTJ_Mon_DisAppear' requested row 'Play_Obj_Season_S11_THTJ_Mon_DisAppear' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,

  // Clockwork Ballet. The podium opens a few seconds into the map and creates
  // the tracker greyed out; a spinning cogwheel lights it and its explosion
  // greys it out again. s7Turnin fires for failures too, with the fail page
  // following ~2s later.
  s7Podium:       `${ts}TLLua: Display: [Game] AudioMgr@PlayAudio  AudioEnum  == S7_3X1_Open`,
  // A LOOP: re-fires every ~2.8s while a cogwheel spins, so it cannot identify
  // individual cogwheels. The explosion is the one definitive per-fight marker.
  s7Cogwheel:     `${ts}[476]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_S7_WOJLB_Machine_Gear_Idle_Common_Lp' requested row 'Play_Obj_S7_WOJLB_Machine_Gear_Idle_Common_Lp' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  s7CogwheelEnd:  `${ts}[476]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_S7_WOJLB_Machine_Gear_Exp_Common' requested row 'Play_Obj_S7_WOJLB_Machine_Gear_Exp_Common' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  // The cogwheel's own mobs scatter across the map, so they are NOT activity.
  s7CogwheelMob:  `${ts}TLGame: Display: [Game] Monster Created: npc id 2610011 rarity 1`,
  s7Turnin:       `${ts}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = S7GamePlayStateStart PushState = S7GamePlayStateSuccess`,
  s7Fail:         `${ts}TLLua: Display: [Game] PageBase@ OpenFlow0! Switch = true S7GamePlayFailStateItem 8292819`,
  s7Heartbeat:    `${ts}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = S7GamePlayStateStart PushState = S7GamePlayStateStart`,

  s14Strum: `${ts}TLGame: Display: [Game] UECtrlComponent@ DoAction S14GameplayStart`,

  // In-map Sandlord coin tile. The markers are genuinely-missing Wwise audio
  // rows, so each surfaces as a LogDataTable FindRow warning.
  // The tile's idle ambient loop — fires on proximity, up to 43.8s before the
  // real activation. Deliberately ignored by the processor.
  s10Proximity:    `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S10_Machine_Normal_Lp' requested row 'Play_Obj_Season_S10_Machine_Normal_Lp' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  s10Wave:         `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S10_Machine_PaLu_Active_Lp' requested row 'Play_Obj_Season_S10_Machine_PaLu_Active_Lp' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  s10WaveResource: `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S10_Machine_Resource_Active_Lp' requested row 'Play_Obj_Season_S10_Machine_Resource_Active_Lp' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  s10Quench:       `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S10_Machine_PaLu_Quench' requested row 'Play_Obj_Season_S10_Machine_PaLu_Quench' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  s10Land:         `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S10_WuZhuangZhe_Land' requested row 'Play_Obj_Season_S10_WuZhuangZhe_Land' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,

  // Afterlight (S15) in-map encounter. Like the S10 tile markers these are
  // missing Wwise audio rows, so each surfaces as a LogDataTable FindRow
  // warning. Only JiangJun/XinNiang are encounters — YouHun (a mid-fight NPC)
  // and Box (a reward chest) share the prefix but never have a _Win, and a
  // YouHun_App fires *inside* an ongoing encounter.
  afterlightStart:      `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S15_ShouYe_JiangJun_App' requested row 'Play_Obj_Season_S15_ShouYe_JiangJun_App' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  afterlightEnd:        `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S15_ShouYe_JiangJun_Win' requested row 'Play_Obj_Season_S15_ShouYe_JiangJun_Win' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  afterlightBrideStart: `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S15_ShouYe_XinNiang_App' requested row 'Play_Obj_Season_S15_ShouYe_XinNiang_App' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  afterlightBrideEnd:   `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S15_ShouYe_XinNiang_Win' requested row 'Play_Obj_Season_S15_ShouYe_XinNiang_Win' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  afterlightGhost:      `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S15_ShouYe_YouHun_App' requested row 'Play_Obj_Season_S15_ShouYe_YouHun_App' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  afterlightBox:        `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S15_ShouYe_Box_App' requested row 'Play_Obj_Season_S15_ShouYe_Box_App' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  afterlightLose:       `${ts}[249]LogDataTable: Warning: UDataTable::FindRow : 'Play_Obj_Season_S15_ShouYe_JiangJun_Lose' requested row 'Play_Obj_Season_S15_ShouYe_JiangJun_Lose' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`,
  // The BGM bracket that identifies a non-Core variant. Special usually logs no
  // boss death at all, so its Stop is the encounter's only reliable end.
  afterlightSpecialStart: `${ts}[634]TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S15_Gameplay_MusicEvents/Play_Mus_Gameplay_S15_Special.Play_Mus_Gameplay_S15_Special id 418016`,
  afterlightSpecialEnd:   `${ts}[634]TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S15_Gameplay_MusicEvents/Stop_Mus_Gameplay_S15_Special.Stop_Mus_Gameplay_S15_Special id 419001`,
  afterlightCoreStart:    `${ts}[634]TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/S15_Gameplay_MusicEvents/Play_Mus_Gameplay_S15_Core.Play_Mus_Gameplay_S15_Core id 34174`,
  // A wave mob. 299-prefixed npc ids fire only inside an Afterlight encounter.
  afterlightWave:       `${ts}[ 54]TLGame: Display: [Game] Monster Created: npc id 2990103 rarity 1`,
  // A generic map mob — same line shape, non-Afterlight id, must be ignored.
  monsterCreated:       `${ts}[ 54]TLGame: Display: [Game] Monster Created: npc id 1140043 rarity 1`,

  huntingStatue:    `${ts}TLLua: Display: [Game] FightMgr:OnGatherEnd logicEtyId 11 cfgId 20004 altlasId -1`,
  huntingBossStart: `${ts}TLLua: Display: [Game] FightHunting BossStatus1`,
  huntingBossEnd:   `${ts}TLLua: Display: [Game] FightHunting BossStatus0`,

  s9Minigame: `${ts}TLLua: Display: [Game] S9Taro Run`,
  s9Fight:    `${ts}TLLua: Display: [Game] S9Challenge Run`,
  // Player backed out of the Tarot Path panel without fighting (real-log marker).
  s9Close:    `${ts}TLLua: Display: [Game] PageApplyBase@ OnPageBackEvent FuncId = 41700_S9TaroCtrl`,
};

// ---------------------------------------------------------------------------
// Scene constants
// ---------------------------------------------------------------------------

export const TOWN = 'XZ_YuJinZhiXiBiNanSuo200';
export const MAP  = '/Game/Art/Maps/S5_Boss';
export const VOREX_REWARD     = '/Game/Art/Season/S13/Maps/DiXiaZhenSuo/DiXiaZhenSuo.DiXiaZhenSuo';
export const SANDLORD_HUB     = '/Game/Art/Season/S10/Maps/YunDuanLvZhou/YunDuanLvZhou.YunDuanLvZhou';
export const SANDLORD_SUB_MAP = '/Game/Art/Maps/06SQ/SQ_NvShenQunBai100/SQ_NvShenQunBai100.SQ_NvShenQunBai100';
export const ARCANA_FIGHT      = '/Game/Art/Season/S9/Maps/SuMingTaLuo/SuMingTaLuo000.SuMingTaLuo000';
export const TARTARUS_FIGHT    = '/Game/Art/Season/S16/Maps/ZhongZuiDiYu/ZhongZuiDiYu.ZhongZuiDiYu';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The production processor chain (shared with the worker). */
export function createDispatcher(): Dispatcher {
  return createProductionDispatcher();
}

/** The production handler chain. The `events` array is mutated in place via
 *  the engine's emit closure; tests inspect it for assertion. */
export function createEngine(events: EngineEvent[]): Engine {
  return createProductionEngine((e) => events.push(e));
}

/** Variant of createEngine that takes a custom emit function — used by the
 *  Sandlord hasActiveMapTracker discriminator tests where the captor needs
 *  closure access to the Engine instance to call hasActiveMapTracker(). */
export function createEngineWithEmit(emit: EmitFn): Engine {
  return createProductionEngine(emit);
}

/** Feed a log line through the full dispatcher → engine pipeline. */
export function feed(dispatcher: Dispatcher, engine: Engine, line: string): void {
  for (const event of dispatcher.dispatch(line)) {
    engine.onRawEvent(event);
  }
}

/** Reach into the engine's private context (test-only). */
export function ctx(engine: Engine): EngineContext {
  return (engine as unknown as {_ctx: EngineContext})._ctx;
}

/** Test-only handler accessor for asserting handler-local state. */
export function overrealm(engine: Engine): OverrealmHandler {
  return engine.getHandler('overrealm') as OverrealmHandler;
}

/** Boot engine and complete bag init with a given inventory. */
export function boot(
  dispatcher: Dispatcher,
  engine: Engine,
  inventory: Array<{slotId: number; itemId: number; quantity: number}>,
): void {
  engine.start();
  for (const {slotId, itemId, quantity} of inventory) {
    feed(dispatcher, engine, log.bagInit(slotId, itemId, quantity));
  }
  vi.advanceTimersByTime(600); // BagInitHandler debounce
}
