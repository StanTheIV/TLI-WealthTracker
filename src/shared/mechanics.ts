/**
 * One row per seasonal mechanic — `SeasonalType`, the filter scopes, the scene
 * markers, the map-freezing set, the settings-backed windows and the Sessions
 * colours all derive from it. Row order is the filter-scope chip order; display
 * order is not this table's (Sessions `ORDER`, domain/session-analytics).
 *
 * Categories (docs/GAMEPLAY.md): 'interlude' freezes the map (its handler calls
 * `pauseMapForInterlude`); 'in-map' runs inside a running map; phased is
 * Sandlord — the coin tile in-map (phase 'map'), the hub its own area that
 * freezes the map (phase 'hub'; a null phase is legacy 'hub').
 */

/** Sandlord's two phases and what each one is. */
export interface PhasedCategory {
  readonly map: 'in-map';
  readonly hub: 'own-area';
}

export type MechanicCategory = 'interlude' | 'in-map' | PhasedCategory;

/** A phase of a phased mechanic. Structurally the contracts' `SeasonalPhase`. */
export type MechanicPhase = keyof PhasedCategory;

/** A settings-backed window: how long a seasonal keeps owning drops after its
 *  last activity. 'loot' — a post-activity pickup window; 'wave' — a
 *  wave-activity window that pickups never extend (the Sandlord tile). */
export interface MechanicWindow {
  /** Settings-table key; the value is milliseconds as a string. */
  readonly settingKey: string;
  readonly defaultMs:  number;
  readonly kind:       'loot' | 'wave';
}

export interface MechanicRow {
  readonly key:         string;
  readonly category:    MechanicCategory;
  /** Scene-path substring of the scene the interlude plays out in (the Arcana
   *  fight, the Vorex reward zone, the Tartarus prison). ZoneHandler classifies
   *  it as a 'seasonal-scene', never as a map. */
  readonly fightScene?: string;
  /** Scene-path substring of a phased mechanic's own area (the Sandlord hub). */
  readonly hubScene?:   string;
  /** Null when the mechanic's end is logged and needs no timed window. */
  readonly window:      MechanicWindow | null;
  /** The renderer Theme key the Sessions charts colour this mechanic with. */
  readonly themeKey:    string;
}

export const MECHANICS = [
  {key: 'vorex',      category: 'interlude', fightScene: 'DiXiaZhenSuo', window: null, themeKey: 'typeEmber'},
  {key: 'dream',      category: 'in-map',    window: null, themeKey: 'typeDream'},
  {key: 'overrealm',  category: 'in-map',    window: {settingKey: 'overrealmLootMs',  defaultMs: 5_000,  kind: 'loot'}, themeKey: 'accent'},
  {key: 'carjack',    category: 'in-map',    window: {settingKey: 'carjackLootMs',    defaultMs: 5_000,  kind: 'loot'}, themeKey: 'typeCard'},
  {key: 'clockwork',  category: 'in-map',    window: {settingKey: 'clockworkLootMs',  defaultMs: 5_000,  kind: 'loot'}, themeKey: 'typeCube'},
  {key: 'sandlord',   category: {map: 'in-map', hub: 'own-area'}, hubScene: 'YunDuanLvZhou',
   window: {settingKey: 'sandlordWaveMs', defaultMs: 10_000, kind: 'wave'}, themeKey: 'gold'},
  {key: 'lunaria',    category: 'in-map',    window: {settingKey: 'lunariaLootMs',    defaultMs: 5_000,  kind: 'loot'}, themeKey: 'typeFuel'},
  {key: 'arcana',     category: 'interlude', fightScene: 'SuMingTaLuo',  window: null, themeKey: 'typeSkill'},
  {key: 'hunting',    category: 'in-map',    window: {settingKey: 'huntingLootMs',    defaultMs: 5_000,  kind: 'loot'}, themeKey: 'hunt'},
  {key: 'afterlight', category: 'in-map',    window: {settingKey: 'afterlightLootMs', defaultMs: 5_000,  kind: 'loot'}, themeKey: 'afterlight'},
  {key: 'tartarus',   category: 'interlude', fightScene: 'ZhongZuiDiYu', window: null, themeKey: 'tartarus'},
] as const satisfies readonly MechanicRow[];

export type Mechanic = (typeof MECHANICS)[number];

export type SeasonalType = Mechanic['key'];

/** A row with a settings-backed window. */
export type WindowedMechanic = Extract<Mechanic, {window: MechanicWindow}>;

/** The mechanics with a settings-backed window. */
export type WindowedSeasonalType = WindowedMechanic['key'];

/** The windowed rows, in table order. */
export const WINDOWED_MECHANICS: readonly WindowedMechanic[] =
  MECHANICS.filter((m): m is WindowedMechanic => m.window !== null);

/** Every Theme key a mechanic is coloured with; the renderer checks they exist. */
export type MechanicThemeKey = Mechanic['themeKey'];

const BY_KEY: ReadonlyMap<string, Mechanic> = new Map(MECHANICS.map(m => [m.key, m]));

/** The row of `type`, typed as exactly that row. */
export function mechanic<T extends SeasonalType>(type: T): Extract<Mechanic, {key: T}> {
  return BY_KEY.get(type) as Extract<Mechanic, {key: T}>;
}

/** True when a run of `type` in `phase` freezes the map clock — so its time is
 *  NOT inside the map's. `phase` matters only for a phased mechanic, where
 *  anything but 'map' is the own area (a null phase is legacy 'hub'). An
 *  unknown type freezes nothing. */
export function isMapFreezing(type: SeasonalType, phase: MechanicPhase | null): boolean {
  const category: MechanicCategory | undefined = BY_KEY.get(type)?.category;
  if (category === undefined || category === 'in-map') return false;
  if (category === 'interlude') return true;
  return (phase === 'map' ? category.map : category.hub) === 'own-area';
}
