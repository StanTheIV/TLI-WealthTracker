import type {useTheme} from '@/theme/ThemeContext';
import type {ItemType} from '@/types/itemType';
import type {MechanicKey} from '../analytics';

type Theme = ReturnType<typeof useTheme>;

/** Map = green to match the per-map chart's bars; town = disabled grey since it
 *  is a residual, not a mechanic. The rest reuse item-type tokens for variety. */
export function mechanicColors(theme: Theme): Record<MechanicKey, string> {
  return {
    map:       theme.success,
    town:      theme.textDisabled,
    unknown:   theme.textDisabled,
    sandlord:  theme.gold,
    overrealm: theme.accent,
    clockwork: theme.typeCube,
    carjack:   theme.typeCard,
    lunaria:   theme.typeFuel,
    vorex:     theme.typeEmber,
    arcana:    theme.typeSkill,
    dream:     theme.typeDream,
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
