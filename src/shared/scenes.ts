/** Scene-path substrings the engine matches zone transitions against. */

export const TOWN_SCENE            = 'YuJinZhiXiBiNanSuo';
export const ARCANA_FIGHT_SCENE    = 'SuMingTaLuo';
export const VOREX_REWARD_SCENE    = 'DiXiaZhenSuo';
export const TARTARUS_PRISON_SCENE = 'ZhongZuiDiYu';
export const SANDLORD_HUB_SCENE    = 'YunDuanLvZhou';

export const MAP_SCENE_PREFIXES = ['/Game/Art/Maps/', '/Game/Art/Season/'];

// Seasonal scenes that live under /Game/Art/Season/ but are owned by a
// seasonal handler, not a generic map tracker. Classifying them as 'map'
// would spin up a phantom map tracker on top of the seasonal one and
// double-count drops. Each entry must correspond to a seasonal that manages
// its own tracker lifecycle via its own log markers:
//   SuMingTaLuo  — Arcana (S9) Fateful Contest scene, owned by ArcanaHandler.
//   DiXiaZhenSuo — Vorex  (S13) reward zone, owned by VorexHandler.
//   ZhongZuiDiYu — Tartarus (S16) prison fight/loot scene, owned by TartarusHandler.
// (Sandlord's S10 scene isn't listed here — it owns a bubble, and ZoneHandler's
//  hasBubble() guard already suppresses the map tracker for it.)
export const SEASONAL_SCENE_MARKERS = [ARCANA_FIGHT_SCENE, VOREX_REWARD_SCENE, TARTARUS_PRISON_SCENE];
