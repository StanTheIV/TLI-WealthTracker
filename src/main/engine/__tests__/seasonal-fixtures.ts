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
import {Dispatcher}        from '@/worker/dispatcher';
import {BagProcessor}      from '@/worker/processors/bag';
import {ZoneProcessor}     from '@/worker/processors/zone';
import {LevelTypeProcessor} from '@/worker/processors/level-type';
import {S13Processor}      from '@/worker/processors/s13';
import {S12Processor}      from '@/worker/processors/s12';
import {S9Processor}       from '@/worker/processors/s9';
import {S11Processor}      from '@/worker/processors/s11';
import {S7Processor}       from '@/worker/processors/s7';
import {S14Processor}      from '@/worker/processors/s14';
import {S10Processor}      from '@/worker/processors/s10';
import {HuntingProcessor}  from '@/worker/processors/hunting';
import {AfterlightProcessor} from '@/worker/processors/afterlight';
import {Engine}            from '@/main/engine/engine';
import {BagInitHandler}    from '@/main/engine/handlers/bag-init';
import {ZoneHandler}       from '@/main/engine/handlers/zone';
import {DreamHandler}      from '@/main/engine/handlers/dream-handler';
import {VorexHandler}      from '@/main/engine/handlers/vorex-handler';
import {OverrealmHandler}  from '@/main/engine/handlers/overrealm-handler';
import {CarjackHandler}    from '@/main/engine/handlers/carjack-handler';
import {ClockworkHandler}  from '@/main/engine/handlers/clockwork-handler';
import {LunariaHandler}    from '@/main/engine/handlers/lunaria-handler';
import {ArcanaHandler}     from '@/main/engine/handlers/arcana-handler';
import {SandlordHandler}   from '@/main/engine/handlers/sandlord-handler';
import {SandlordMapHandler} from '@/main/engine/handlers/sandlord-map-handler';
import {HuntingHandler}    from '@/main/engine/handlers/hunting-handler';
import {AfterlightHandler} from '@/main/engine/handlers/afterlight-handler';
import {ItemHandler}       from '@/main/engine/handlers/item';
import type {EngineEvent, EmitFn}  from '@/main/engine/types';
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

  zoneTransition: (from: string, to: string) =>
    `PageApplyBase@ _UpdateGameEnd: LastSceneName = World'${from}' NextSceneName = World'${to}'`,

  levelType: (n: number) =>
    `${ts} PreloadLevelType = ${n}`,

  s13Start:       `${ts} S13GamePlayMain Run`,
  s13WindowClose: `${ts} S13GamePlayMain::Destory`,
  s13Abandon:     `${ts} S13GamePlay Destory`,

  // Overrealm entry = LevelType 25 transition; exit = notifyId 101 success.
  s12Entry:       `${ts}TLShipping: Display: [Game] LevelMgr@ LevelUid, LevelType, LevelId = 1121406 25 5354`,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Dispatcher pre-registered with every processor used by the
 *  seasonal integration tests. */
export function createDispatcher(): Dispatcher {
  const d = new Dispatcher();
  d.register(new BagProcessor());
  d.register(new ZoneProcessor());
  d.register(new LevelTypeProcessor());
  d.register(new S13Processor());
  d.register(new S12Processor());
  d.register(new S9Processor());
  d.register(new S11Processor());
  d.register(new S7Processor());
  d.register(new S14Processor());
  d.register(new S10Processor());
  d.register(new HuntingProcessor());
  d.register(new AfterlightProcessor());
  return d;
}

/** Standard handler chain — registration order matches production
 *  (ipc/engine.ts). The `events` array is mutated in place via the engine's
 *  emit closure; tests inspect it for assertion. */
export function createEngine(events: EngineEvent[]): Engine {
  return registerHandlers(new Engine((e) => events.push(e)));
}

/** Variant of createEngine that takes a custom emit function — used by the
 *  Sandlord hasActiveMapTracker discriminator tests where the captor needs
 *  closure access to the Engine instance to call hasActiveMapTracker(). */
export function createEngineWithEmit(emit: EmitFn): Engine {
  return registerHandlers(new Engine(emit));
}

function registerHandlers(engine: Engine): Engine {
  return engine
    .register(new BagInitHandler())
    .register(new SandlordHandler())  // before ZoneHandler — sets ctx.seasonals.get('sandlord').ownsBubble
    .register(new ZoneHandler())
    .register(new DreamHandler())
    .register(new VorexHandler())
    .register(new OverrealmHandler())
    .register(new CarjackHandler())
    .register(new ClockworkHandler())
    .register(new LunariaHandler())
    .register(new ArcanaHandler())
    .register(new SandlordMapHandler())
    .register(new HuntingHandler())
    .register(new AfterlightHandler())  // before ItemHandler — shares bag_update
    .register(new ItemHandler());
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
