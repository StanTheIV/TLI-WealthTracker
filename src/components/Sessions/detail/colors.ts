import type {useTheme} from '@/theme/ThemeContext';
import type {ItemType} from '@/shared/items';
import type {MechanicKey} from '@/domain/session-analytics';
import {MECHANICS, type SeasonalType} from '@/shared/mechanics';

type Theme = ReturnType<typeof useTheme>;

/** Map = green to match the per-map chart's bars; town = disabled grey since it
 *  is a residual, not a mechanic. Each mechanic's colour is its table themeKey. */
export function mechanicColors(theme: Theme): Record<MechanicKey, string> {
  const seasonal = Object.fromEntries(
    MECHANICS.map(m => [m.key, theme[m.themeKey satisfies keyof Theme]]),
  ) as Record<SeasonalType, string>;
  return {
    map:     theme.success,
    town:    theme.textDisabled,
    unknown: theme.textDisabled,
    ...seasonal,
  };
}

export function typeColors(theme: Theme): Record<ItemType, string> {
  return {
    ember:       theme.typeEmber,
    fuel:        theme.typeFuel,
    compass:     theme.accent,
    dream:       theme.typeDream,
    cube:        theme.typeCube,
    card:        theme.typeCard,
    skill:       theme.typeSkill,
    equipment:   theme.success,
    mapMaterial: theme.gold,
    other:       theme.textDisabled,
  };
}
