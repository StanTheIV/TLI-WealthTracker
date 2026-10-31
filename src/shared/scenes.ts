/** Scene-path substrings the engine matches zone transitions against. The
 *  seasonal ones come from the MECHANICS table. */
import {MECHANICS, mechanic} from './mechanics';

export const TOWN_SCENE            = 'YuJinZhiXiBiNanSuo';
export const ARCANA_FIGHT_SCENE    = mechanic('arcana').fightScene;
export const VOREX_REWARD_SCENE    = mechanic('vorex').fightScene;
export const TARTARUS_PRISON_SCENE = mechanic('tartarus').fightScene;
export const SANDLORD_HUB_SCENE    = mechanic('sandlord').hubScene;

export const MAP_SCENE_PREFIXES = ['/Game/Art/Maps/', '/Game/Art/Season/'];

// Seasonal scenes that live under /Game/Art/Season/ but are owned by a
// seasonal handler, not a generic map tracker. Classifying them as 'map'
// would spin up a phantom map tracker on top of the seasonal one and
// double-count drops. Every interlude's fight scene, each owned by its handler
// via its own log markers. (Sandlord's hub isn't listed — ZoneHandler
// classifies it as the hub, and the map scenes entered from it as its sub-maps.)
export const SEASONAL_SCENE_MARKERS: readonly string[] =
  MECHANICS.flatMap(m => ('fightScene' in m ? [m.fightScene] : []));
