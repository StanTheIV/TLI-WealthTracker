import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';

import commonEN    from './locales/en/common.json';
import sidebarEN   from './locales/en/sidebar.json';
import dashboardEN from './locales/en/dashboard.json';
import settingsEN  from './locales/en/settings.json';
import playbarEN   from './locales/en/playbar.json';
import overlayEN   from './locales/en/overlay.json';
import trackerEN   from './locales/en/tracker.json';
import itemsEN     from './locales/en/items.json';
import sessionsEN  from './locales/en/sessions.json';
import filtersEN   from './locales/en/filters.json';

import commonDE    from './locales/de/common.json';
import sidebarDE   from './locales/de/sidebar.json';
import dashboardDE from './locales/de/dashboard.json';
import settingsDE  from './locales/de/settings.json';
import playbarDE   from './locales/de/playbar.json';
import overlayDE   from './locales/de/overlay.json';
import trackerDE   from './locales/de/tracker.json';
import itemsDE     from './locales/de/items.json';
import sessionsDE  from './locales/de/sessions.json';
import filtersDE   from './locales/de/filters.json';

export const SUPPORTED_LANGUAGES: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
};

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common:    typeof commonEN;
      sidebar:   typeof sidebarEN;
      dashboard: typeof dashboardEN;
      settings:  typeof settingsEN;
      playbar:   typeof playbarEN;
      overlay:   typeof overlayEN;
      tracker:   typeof trackerEN;
      items:     typeof itemsEN;
      sessions:  typeof sessionsEN;
      filters:   typeof filtersEN;
    };
  }
}

i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common', 'sidebar', 'dashboard', 'settings', 'playbar', 'overlay', 'tracker', 'items', 'sessions', 'filters'],
  defaultNS: 'common',
  resources: {
    en: {
      common:    commonEN,
      sidebar:   sidebarEN,
      dashboard: dashboardEN,
      settings:  settingsEN,
      playbar:   playbarEN,
      overlay:   overlayEN,
      tracker:   trackerEN,
      items:     itemsEN,
      sessions:  sessionsEN,
      filters:   filtersEN,
    },
    de: {
      common:    commonDE,
      sidebar:   sidebarDE,
      dashboard: dashboardDE,
      settings:  settingsDE,
      playbar:   playbarDE,
      overlay:   overlayDE,
      tracker:   trackerDE,
      items:     itemsDE,
      sessions:  sessionsDE,
      filters:   filtersDE,
    },
  },
  interpolation: {escapeValue: false},
});

export default i18n;
