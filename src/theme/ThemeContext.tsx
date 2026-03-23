import {type ReactNode, createContext, useContext, useEffect, useState} from 'react';
import {darkTheme, lightTheme, type Theme} from './colors';

const ThemeContext = createContext<Theme>(darkTheme);

export function ThemeProvider({children}: {children: ReactNode}) {
  const [theme, setTheme] = useState<Theme>(
    window.matchMedia('(prefers-color-scheme: light)').matches ? lightTheme : darkTheme,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? lightTheme : darkTheme);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
