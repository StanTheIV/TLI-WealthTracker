import {type ReactNode, createContext, useContext} from 'react';

/** The main window's run commands. The run status and elapsed live in
 *  engineStore (`selectRunStatus`), shared with the overlay. */
interface TrackingCommands {
  /** Resolves true once main started the session; false when the start
   *  failed (logged; main is idle or still on the run in progress). */
  start:           () => Promise<boolean>;
  /** Resolves true once main accepted the continue; false when main refused
   *  it (logged, nothing started). */
  continueSession: (sessionId: string) => Promise<boolean>;
  pause:           () => void;
  resume:          () => void;
  stop:            () => void;
  /** Resolves once main reset the run; a failed reset is logged (main is
   *  then idle — the old session kept, closed). */
  reset:           () => Promise<void>;
}

/** Exported for tests; components use `useTracking()`. */
export const commands: TrackingCommands = {
  start: async () => {
    try {
      await window.electronAPI.engine.start();
    } catch (err) {
      console.error('[session] start refused:', err);
      return false;
    }
    window.electronAPI.overlay.show();
    return true;
  },

  continueSession: async (sessionId) => {
    // Main refuses a missing, non-drop-through or active session. The Playbar
    // badge name arrives with the session tracker_started (engineStore).
    try {
      await window.electronAPI.engine.startWithSession(sessionId);
    } catch (err) {
      console.error('[session] continue refused:', err);
      return false;
    }
    window.electronAPI.overlay.show();
    return true;
  },

  pause:  () => window.electronAPI.engine.pause(),
  resume: () => window.electronAPI.engine.resume(),

  stop: () => {
    window.electronAPI.engine.stop();
    window.electronAPI.overlay.hide();
  },

  reset: async () => {
    try {
      await window.electronAPI.engine.reset();
    } catch (err) {
      console.error('[session] reset failed:', err);
    }
  },
};

const TrackingContext = createContext<TrackingCommands | null>(null);

export function TrackingProvider({children}: {children: ReactNode}) {
  return <TrackingContext.Provider value={commands}>{children}</TrackingContext.Provider>;
}

export function useTracking(): TrackingCommands {
  const ctx = useContext(TrackingContext);
  if (!ctx) throw new Error('useTracking must be used within TrackingProvider');
  return ctx;
}
