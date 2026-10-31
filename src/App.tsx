import {useEffect, useState} from 'react';
import {I18nextProvider} from 'react-i18next';
import i18n from './i18n';
import {ThemeProvider} from './theme/ThemeContext';
import {TrackingProvider} from './state/TrackingContext';
import {useSettingsStore} from './state/settingsStore';
import {useItemsStore} from './state/itemsStore';
import {useEngineStore} from './state/engineStore';
import {useWealthStore} from './state/wealthStore';
import {useLeaguesStore} from './state/leaguesStore';
import ErrorBoundary from './components/ui/ErrorBoundary';
import MainWindow from './windows/MainWindow';
import OverlayWindow from './windows/OverlayWindow';

const params = new URLSearchParams(window.location.search);
const windowType = params.get('window') ?? 'main';

const OVERLAY_WIDTH           = 360;
/** The compact fallback's height (h-16). */
const OVERLAY_FALLBACK_HEIGHT = 64;

/** The overlay's fallback: sized, shown if a show is pending, and clickable
 *  even when the crash happened mid-run with click-through on. */
function revealOverlayFallback(): void {
  const overlay = window.electronAPI.overlay;
  overlay.setClickThrough(false);
  overlay.setSize(OVERLAY_WIDTH, OVERLAY_FALLBACK_HEIGHT);
  overlay.notifyReady();
}

function AppInner() {
  const [ready, setReady] = useState(false);
  const [initFailure, setInitFailure] = useState<{error: unknown} | null>(null);

  useEffect(() => {
    // Both windows need engine state and item prices.
    // initBroadcastListener subscribes to items:changed so any item edit in
    // any window propagates to this window's itemsStore in real time.
    useItemsStore.getState().initBroadcastListener();
    Promise.all([
      // Caught up with the engine before the first render: no idle flash, and
      // the overlay's click-through starts from the real run status.
      useEngineStore.getState().init(),
      useItemsStore.getState().load(),
      // The overlay inits its settings in OverlayWindow (no log-file check).
      windowType === 'main' ? useSettingsStore.getState().init({checkLogFile: true}) : Promise.resolve(),
      windowType === 'main' ? useWealthStore.getState().load()   : Promise.resolve(),
      windowType === 'main' ? useLeaguesStore.getState().load()  : Promise.resolve(),
    ]).then(() => setReady(true), (error: unknown) => setInitFailure({error}));
  }, []);

  // A failed init shows the ErrorBoundary's panel (reported there), not a blank window.
  if (initFailure) throw initFailure.error;
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
  const overlay = windowType === 'overlay';
  return (
    <ErrorBoundary compact={overlay} onError={overlay ? revealOverlayFallback : undefined}>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <AppInner />
        </ThemeProvider>
      </I18nextProvider>
    </ErrorBoundary>
  );
}
