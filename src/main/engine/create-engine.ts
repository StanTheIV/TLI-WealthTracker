import {Engine} from './engine';
import type {EngineSink} from './types';
import {BagInitHandler} from './handlers/bag-init';
import {ZoneHandler} from './handlers/zone';
import {DreamHandler} from './handlers/dream-handler';
import {VorexHandler} from './handlers/vorex-handler';
import {TartarusHandler} from './handlers/tartarus-handler';
import {OverrealmHandler} from './handlers/overrealm-handler';
import {CarjackHandler} from './handlers/carjack-handler';
import {ClockworkHandler} from './handlers/clockwork-handler';
import {LunariaHandler} from './handlers/lunaria-handler';
import {ArcanaHandler} from './handlers/arcana-handler';
import {SandlordHandler} from './handlers/sandlord-handler';
import {SandlordMapHandler} from './handlers/sandlord-map-handler';
import {HuntingHandler} from './handlers/hunting-handler';
import {AfterlightHandler} from './handlers/afterlight-handler';
import {ItemHandler} from './handlers/item';
import {MapMaterialHandler} from './handlers/map-material';

/**
 * The production handler chain. Shared by the IPC layer, the log replayer and
 * the test fixtures so they can never drift apart. Registration order is
 * routing order — the comments below mark the order-sensitive pairs.
 */
export function createEngine(sink: EngineSink): Engine {
  return new Engine(sink)
    .register(new BagInitHandler())
    .register(new SandlordHandler())  // before ZoneHandler — sets ctx.seasonal.ownsBubble
    .register(new ZoneHandler())
    .register(new DreamHandler())
    .register(new VorexHandler())
    .register(new TartarusHandler())
    .register(new OverrealmHandler())
    .register(new CarjackHandler())
    .register(new ClockworkHandler())
    .register(new LunariaHandler())
    .register(new ArcanaHandler())
    .register(new SandlordMapHandler())
    .register(new HuntingHandler())
    .register(new AfterlightHandler())  // before ItemHandler — both take bag_update; the loot timer must refresh before the drop is distributed
    .register(new ItemHandler())
    .register(new MapMaterialHandler());
}
