import {describe, expect, expectTypeOf, it} from 'vitest';
import {mechanicColors} from '../colors';
import {darkTheme, lightTheme, type Theme} from '@/theme/colors';
import {MECHANICS, type MechanicThemeKey} from '@/shared/mechanics';

describe('mechanicColors', () => {
  it('every MECHANICS themeKey is a Theme key', () => {
    expectTypeOf<MechanicThemeKey>().toExtend<keyof Theme>();
    for (const m of MECHANICS) expect(Object.keys(darkTheme)).toContain(m.themeKey);
  });

  it.each([['dark', darkTheme], ['light', lightTheme]] as const)('maps every mechanic to its colour (%s)', (_name, theme) => {
    expect(mechanicColors(theme)).toEqual({
      map:        theme.success,
      town:       theme.textDisabled,
      unknown:    theme.textDisabled,
      sandlord:   theme.gold,
      overrealm:  theme.accent,
      clockwork:  theme.typeCube,
      carjack:    theme.typeCard,
      lunaria:    theme.typeFuel,
      vorex:      theme.typeEmber,
      arcana:     theme.typeSkill,
      dream:      theme.typeDream,
      hunting:    theme.hunt,
      afterlight: theme.afterlight,
      tartarus:   theme.tartarus,
    });
  });
});
