import {type ReactNode, createContext, useContext, useEffect, useState} from 'react';
import {darkTheme, lightTheme, type Theme} from './colors';
import {useSettingsStore} from '@/state/settingsStore';

const ThemeContext = createContext<Theme>(darkTheme);

function resolveTheme(mode: string, systemLight: boolean): 'dark' | 'light' {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemLight ? 'light' : 'dark';
}

export function ThemeProvider({children}: {children: ReactNode}) {
  const themeMode = useSettingsStore(s => s.themeMode);
  const [systemLight, setSystemLight] = useState(
    window.matchMedia('(prefers-color-scheme: light)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => setSystemLight(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const effective = resolveTheme(themeMode, systemLight);

  useEffect(() => {
    document.documentElement.classList.toggle('light', effective === 'light');
  }, [effective]);

  const theme = effective === 'light' ? lightTheme : darkTheme;

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
