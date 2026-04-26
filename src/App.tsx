import {useEffect, useState} from 'react';
import {I18nextProvider} from 'react-i18next';
import i18n from './i18n';
import {ThemeProvider} from './theme/ThemeContext';
import {TrackingProvider} from './state/TrackingContext';
import {useSettingsStore} from './state/settingsStore';
import {useItemsStore} from './state/itemsStore';
import {useEngineStore} from './state/engineStore';
import {useWealthStore} from './state/wealthStore';
import MainWindow from './windows/MainWindow';
import OverlayWindow from './windows/OverlayWindow';

const params = new URLSearchParams(window.location.search);
const windowType = params.get('window') ?? 'main';

function AppInner() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Both windows need engine events and item prices.
    // initBroadcastListener subscribes to items:changed so any item edit in
    // any window propagates to this window's itemsStore in real time.
    useEngineStore.getState().init();
    useItemsStore.getState().initBroadcastListener();
    Promise.all([
      useItemsStore.getState().load(),
      windowType === 'main' ? useSettingsStore.getState().load() : Promise.resolve(),
      windowType === 'main' ? useWealthStore.getState().load()   : Promise.resolve(),
    ]).then(() => setReady(true));
  }, []);

  if (!ready) return <div className="h-full bg-bg" />;

  return (
    <>
      {windowType === 'main' && (
        <TrackingProvider>
          <MainWindow />
        </TrackingProvider>
      )}
      {windowType === 'overlay' && <OverlayWindow />}
    </>
  );
}

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <AppInner />
      </ThemeProvider>
    </I18nextProvider>
  );
}
