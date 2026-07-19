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
import {S11Processor}      from '@/worker/processors/s11';
import {S7Processor}       from '@/worker/processors/s7';
import {S14Processor}      from '@/worker/processors/s14';
import {CurrencyProcessor} from '@/worker/processors/currency';
import {Engine}            from '@/main/engine/engine';
import {BagInitHandler}    from '@/main/engine/handlers/bag-init';
import {ZoneHandler}       from '@/main/engine/handlers/zone';
import {DreamHandler}      from '@/main/engine/handlers/dream-handler';
import {VorexHandler}      from '@/main/engine/handlers/vorex-handler';
import {OverrealmHandler}  from '@/main/engine/handlers/overrealm-handler';
import {CarjackHandler}    from '@/main/engine/handlers/carjack-handler';
import {ClockworkHandler}  from '@/main/engine/handlers/clockwork-handler';
import {LunariaHandler}    from '@/main/engine/handlers/lunaria-handler';
import {SandlordHandler}   from '@/main/engine/handlers/sandlord-handler';
import {ItemHandler}       from '@/main/engine/handlers/item';
import type {EngineEvent}  from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';
import type {EmitFn}       from '@/main/engine/types';

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

  s7Start:   `${ts}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = -1 PushState = S7GamePlayStateStart`,
  s7Success: `${ts}TLLua: Display: [Game] S7GamePlayMgr@HandleS7PushData GamePlayState = S7GamePlayStateStart PushState = S7GamePlayStateSuccess`,
  s7Fail:    `${ts}TLLua: Display: [Game] PageBase@ OpenFlow0! Switch = true S7GamePlayFailStateItem 8292819`,

  s14Strum: `${ts}TLGame: Display: [Game] UECtrlComponent@ DoAction S14GameplayStart`,

  currency: (id: number, amount: number) =>
    `${ts} ResourceMgr@:ChangeCurrency(${id}, ${amount})`,
};

// ---------------------------------------------------------------------------
// Scene constants
// ---------------------------------------------------------------------------

export const TOWN = 'XZ_YuJinZhiXiBiNanSuo200';
export const MAP  = '/Game/Art/Maps/S5_Boss';
export const VOREX_REWARD     = '/Game/Art/Season/S13/DiXiaZhenSuo_Reward';
export const SANDLORD_HUB     = '/Game/Art/Season/S10/Maps/YunDuanLvZhou/YunDuanLvZhou.YunDuanLvZhou';
export const SANDLORD_SUB_MAP = '/Game/Art/Maps/06SQ/SQ_NvShenQunBai100/SQ_NvShenQunBai100.SQ_NvShenQunBai100';

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
  d.register(new S11Processor());
  d.register(new S7Processor());
  d.register(new S14Processor());
  d.register(new CurrencyProcessor());
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
