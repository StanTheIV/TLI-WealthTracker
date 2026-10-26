/**
 * SYNTHETIC golden scenarios — hand-built logs for mechanics the recorded logs
 * on hand do not cover well enough (no Vorex run, no Afterlight Special ending
 * without `_Win`, no Carjack Stop landing after the run went dormant). They
 * are meant to be replaced by scrubbed real slices once such logs exist.
 *
 * Every marker is the exact text the production processors match
 * (`src/worker/processors/**`, as in the `log.*` builders of
 * `src/main/engine/__tests__/seasonal-fixtures.ts`); the line prefixes and
 * scene paths copy the shape of the real fixtures. Each line carries its own
 * timestamp, and each map scenario runs a bag dump in town, a paid map entry,
 * the mechanic, and the return to town (`town-panel-activity` never enters a
 * map). Item ids come from `items.ts`.
 */
import {formatLogTimestamp} from '@/replay/log-source';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0, 0);

const TOWN = '/Game/Art/Maps/01SD/XZ_YuJinZhiXiBiNanSuo200/XZ_YuJinZhiXiBiNanSuo200.XZ_YuJinZhiXiBiNanSuo200';
const MAP  = '/Game/Art/Maps/05JH/JH_ShengDeLanXiuDaoYuan000/JH_ShengDeLanXiuDaoYuan000.JH_ShengDeLanXiuDaoYuan000';
const VOREX_REWARD = '/Game/Art/Season/S13/Maps/DiXiaZhenSuo/DiXiaZhenSuo.DiXiaZhenSuo';
const ARCANA_FIGHT = '/Game/Art/Season/S9/Maps/SuMingTaLuo/SuMingTaLuo000.SuMingTaLuo000';

export const FE         = 100300; // fuel
const COMPASS    = 10240;  // entry material
const PROBE      = 400015; // entry material
const MATERIAL   = 5028;
const CARD       = 6004;
export const CUBE       = 5210;
const RARE_CARD  = 6153;

const audioRow = (row: string) =>
  `[249]LogDataTable: Warning: UDataTable::FindRow : '${row}' requested row '${row}' not in DataTable '/Game/Audio/BluePrint/CD/AudioCDTable.AudioCDTable'.`;
const bgm = (folder: string, event: string, id: number) =>
  `[634]TLGame: Display: [Game] Play audio PostEventAsync bgm /Game/WwiseAudio_EBP/HotUpdate/Events/Music/Gameplay/${folder}/${event}.${event} id ${id}`;

export const BODY = {
  snapshotStart: '[ 36]TLLua: Display: [Game] ItemChange@ Reset PageId=102',
  levelType:     (levelId: number, type: number) => `[612]TLShipping: Display: [Game] Loading@ PreLoadLevelId = ${levelId} PreloadLevelType = ${type}`,
  zone:          (from: string, to: string) => `[612]TLLua: Display: [Game] PageApplyBase@ _UpdateGameEnd: LastSceneName = World'${from}' NextSceneName = World'${to}'`,

  // Arcana (S9) panel markers, as the s9 processor matches them.
  s9Minigame:     '[ 20]TLLua: Display: [Game] S9Taro Run',
  s9Close:        '[ 20]TLLua: Display: [Game] PageApplyBase@ OnPageBackEvent FuncId = 41700_S9TaroCtrl',

  s13Start:       '[ 85]TLLua: Display: [Game] S13GamePlayMain Run',
  s13WindowClose: '[ 85]TLLua: Display: [Game] S13GamePlayMain::Destory',
  s13Abandon:     '[ 85]TLLua: Display: [Game] S13GamePlay Destory',

  afterlightStart:   audioRow('Play_Obj_Season_S15_ShouYe_JiangJun_App'),
  afterlightGhost:   audioRow('Play_Obj_Season_S15_ShouYe_YouHun_App'),
  afterlightBox:     audioRow('Play_Obj_Season_S15_ShouYe_Box_App'),
  afterlightWave:    '[ 54]TLGame: Display: [Game] Monster Created: npc id 2990103 rarity 1',
  specialStart:      bgm('S15_Gameplay_MusicEvents', 'Play_Mus_Gameplay_S15_Special', 418016),
  specialStop:       bgm('S15_Gameplay_MusicEvents', 'Stop_Mus_Gameplay_S15_Special', 419001),

  carjackStart:   bgm('S11_Gameplay_MusicEvents', 'Play_Mus_Gameplay_S11_Robbery_Full', 3808),
  carjackStop:    bgm('S11_Gameplay_MusicEvents', 'Stop_Mus_Gameplay_S11_Robbery_Full', 10149),
  carjackAppear:  audioRow('Play_Obj_Season_S11_THTJ_Mon_Appear'),
  carjackKill:    audioRow('Play_Obj_Season_S11_THTJ_Mon_Die_Gold2'),
  carjackDespawn: audioRow('Play_Obj_Season_S11_THTJ_Mon_DisAppear'),
};

/** A log under construction. Bag lines carry absolute stack sizes, as the game
 *  writes them, so the builder tracks each item's slot and current count. */
class Script {
  private readonly _lines: string[] = [];
  private readonly _slots = new Map<number, {slot: number; qty: number}>();

  line(atSec: number, body: string): this {
    this._lines.push(`${formatLogTimestamp(T0 + Math.round(atSec * 1000))}${body}`);
    return this;
  }

  /** A full bag dump: the Reset marker, then one InitBagData line per slot. */
  dump(atSec: number, inventory: Array<[itemId: number, qty: number]>): this {
    this.line(atSec, BODY.snapshotStart);
    for (const [itemId, qty] of inventory) {
      const slot = this._slots.size + 1;
      this._slots.set(itemId, {slot, qty});
      this.line(atSec + 0.001, `[ 36]TLLua: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = ${slot} ConfigBaseId = ${itemId} Num = ${qty}`);
    }
    return this;
  }

  /** A stack change — a pickup, a spend, or a new item into a free slot. */
  bag(atSec: number, itemId: number, delta: number): this {
    const s = this._slots.get(itemId) ?? {slot: this._slots.size + 1, qty: 0};
    s.qty += delta;
    this._slots.set(itemId, s);
    return this.line(atSec, `[600]TLLua: Display: [Game] BagMgr@:Modfy BagItem PageId = 102 SlotId = ${s.slot} ConfigBaseId = ${itemId} Num = ${s.qty}`);
  }

  zone(atSec: number, from: string, to: string, levelType: [levelId: number, type: number]): this {
    this.line(atSec - 0.05, BODY.levelType(...levelType));
    return this.line(atSec, BODY.zone(from, to));
  }

  /** Town with a bag dump, then entry materials paid just before entering a map. */
  static townToMap(): Script {
    return new Script()
      .dump(0, [[FE, 500], [COMPASS, 10], [PROBE, 5], [MATERIAL, 50], [CARD, 3], [CUBE, 20]])
      .bag(20, COMPASS, -1)
      .bag(20.4, PROBE, -1)
      .zone(21, TOWN, MAP, [5318, 3])
      .bag(30, FE, 12)
      .bag(35, RARE_CARD, 1);
  }

  text(): string {
    return this._lines.join('\n') + '\n';
  }
}

const TOWN_LEVEL: [number, number] = [110, 0];
const ARCANA_LEVEL: [number, number] = [203018, 19];
const VOREX_LEVEL: [number, number] = [9999997, 22];

/** Map → Vorex window → DiXiaZhenSuo reward zone → town (the reward zone
 *  always exits to town). Committing fires window close + abandon just before
 *  the zone change. */
const mapVorex = Script.townToMap()
  .line(45, BODY.s13Start)
  .line(60, BODY.s13WindowClose)
  .line(60.05, BODY.s13Abandon)
  .zone(60.55, MAP, VOREX_REWARD, VOREX_LEVEL)
  .bag(70, FE, 28)
  .bag(72, MATERIAL, 8)
  .bag(75, CARD, 1)
  .zone(90, VOREX_REWARD, TOWN, TOWN_LEVEL)
  .bag(95, MATERIAL, -8) // town activity, not loot
  .text();

/** Afterlight Special: the General appears, the Special BGM brackets the fight,
 *  waves stop and the run goes dormant, then the BGM Stop ends it — with no
 *  `_Win`/`_Lose` row at all — and the casket is looted after the Stop. */
const afterlightSpecialNoWin = Script.townToMap()
  .line(40, BODY.afterlightStart)
  .line(40.2, BODY.specialStart)
  .line(41, BODY.afterlightWave)
  .line(43, BODY.afterlightWave)
  .line(45, BODY.afterlightWave)
  .line(48, BODY.afterlightWave)
  .line(50, BODY.afterlightWave)
  .bag(52, FE, 20)
  .bag(54, CUBE, 4)
  .line(62, BODY.afterlightBox)
  .line(63, BODY.afterlightGhost)
  .line(64, BODY.specialStop)
  .bag(65, RARE_CARD, 1)
  .bag(66, FE, 15)
  .bag(80, MATERIAL, 3)
  .zone(90, MAP, TOWN, TOWN_LEVEL)
  .text();

/** Carjack: combat markers stop, the run parks dormant, and the (late, fixed-
 *  sequence) Stop arrives ~13 s into the dormancy, followed by the loot and the
 *  duplicate bare Stop. `Mon_DisAppear` in between is not activity. */
const carjackStopAfterDormancy = Script.townToMap()
  .line(40, BODY.carjackStart)
  .line(41, BODY.carjackAppear)
  .line(42.5, BODY.carjackKill)
  .line(44, BODY.carjackKill)
  .bag(45, FE, 10)
  .line(46, BODY.carjackKill)
  .line(48, BODY.carjackKill)
  .bag(49, CUBE, 3)
  .line(50, BODY.carjackKill)
  .line(60, BODY.carjackDespawn)
  .line(68, BODY.carjackStop)
  .bag(69, FE, 25)
  .bag(70, CARD, 2)
  .line(90, BODY.carjackStop)
  .bag(95, MATERIAL, 4)
  .zone(110, MAP, TOWN, TOWN_LEVEL)
  .text();

/** Town-only Arcana: the Tarot panel opened in town, bag activity, backed out,
 *  more bag activity, reopened, then the Fateful Contest (+12 FE, +2 cubes) and
 *  back to town for more town activity. Only the fight's loot is session loot;
 *  no map is ever entered. */
const townPanelActivity = new Script()
  .dump(0, [[FE, 500], [MATERIAL, 50], [CUBE, 20]])
  .line(10, BODY.s9Minigame)
  .bag(12, FE, 5)
  .line(14, BODY.s9Close)
  .bag(16, FE, 2)
  .line(18, BODY.s9Minigame)
  .zone(20, TOWN, ARCANA_FIGHT, ARCANA_LEVEL)
  .bag(25, FE, 12)
  .bag(27, CUBE, 2)
  .zone(40, ARCANA_FIGHT, TOWN, TOWN_LEVEL)
  .bag(45, MATERIAL, -8) // town activity
  .bag(50, FE, 3)        // town activity
  .text();

export const SYNTHETIC_FIXTURES = {
  'map-vorex':                   mapVorex,
  'afterlight-special-no-win':   afterlightSpecialNoWin,
  'carjack-stop-after-dormancy': carjackStopAfterDormancy,
  'town-panel-activity':         townPanelActivity,
} as const;
