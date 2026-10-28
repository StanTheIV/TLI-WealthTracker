import {type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {useEngineStore} from './engineStore';

export type TrackingStatus = 'idle' | 'running' | 'paused';

interface TrackingState {
  status:    TrackingStatus;
  elapsedMs: number;
  sessionId: string | null;
}

interface TrackingContextValue extends TrackingState {
  start:           () => void;
  /** Resolves true once main accepted the continue (local state flipped);
   *  false when main refused it (logged, local state untouched). */
  continueSession: (sessionId: string) => Promise<boolean>;
  pause:           () => void;
  resume:          () => void;
  stop:            () => void;
  reset:           () => void;
}

const TrackingContext = createContext<TrackingContextValue | null>(null);

export function TrackingProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState<TrackingState>({status: 'idle', elapsedMs: 0, sessionId: null});
  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef   = useRef<number>(0);
  const accumulatedRef = useRef<number>(0);
  const statusRef      = useRef<TrackingStatus>('idle');

  const clearTick = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startTick = useCallback(() => {
    clearTick();
    startedAtRef.current = Date.now();
    intervalRef.current = setInterval(() => {
      const elapsed = accumulatedRef.current + (Date.now() - startedAtRef.current);
      setState(prev => ({...prev, elapsedMs: elapsed}));
    }, 100);
  }, [clearTick]);

  const start = useCallback(() => {
    window.electronAPI.engine.start();
    accumulatedRef.current = 0;
    statusRef.current = 'running';
    setState({status: 'running', elapsedMs: 0, sessionId: crypto.randomUUID()});
    // tick starts only after init_complete — see engineStore phase subscription below
    window.electronAPI.overlay.show();
  }, []);

  const continueSession = useCallback(async (sessionId: string) => {
    // Main refuses a missing, non-drop-through or active session: flip local
    // state only once it accepted. The Playbar badge name arrives with the
    // session tracker_started (engineStore), not from here.
    try {
      await window.electronAPI.engine.startWithSession(sessionId);
    } catch (err) {
      console.error('[session] continue refused:', err);
      return false;
    }
    accumulatedRef.current = 0;
    statusRef.current = 'running';
    setState({status: 'running', elapsedMs: 0, sessionId});
    window.electronAPI.overlay.show();
    return true;
  }, []);

  const pause = useCallback(() => {
    if (intervalRef.current !== null) {
      accumulatedRef.current += Date.now() - startedAtRef.current;
    }
    window.electronAPI.engine.pause();
    clearTick();
    statusRef.current = 'paused';
    setState(prev => ({...prev, status: 'paused'}));
  }, [clearTick]);

  const resume = useCallback(() => {
    window.electronAPI.engine.resume();
    statusRef.current = 'running';
    setState(prev => ({...prev, status: 'running'}));
    startTick();
  }, [startTick]);

  const stop = useCallback(() => {
    window.electronAPI.engine.stop();
    clearTick();
    accumulatedRef.current = 0;
    statusRef.current = 'idle';
    setState({status: 'idle', elapsedMs: 0, sessionId: null});
    window.electronAPI.overlay.hide();
  }, [clearTick]);

  const reset = useCallback(() => {
    window.electronAPI.engine.reset();
    accumulatedRef.current = 0;
    if (statusRef.current === 'running') {
      // Restart the local tick so elapsedMs counts from 0.
      setState(prev => ({...prev, elapsedMs: 0, sessionId: crypto.randomUUID()}));
      startTick();
    } else {
      // Paused: just zero the displayed elapsed; tick stays stopped.
      setState(prev => ({...prev, elapsedMs: 0, sessionId: crypto.randomUUID()}));
    }
  }, [startTick]);

  // Start the tick only once the engine finishes bag init.
  // For continued sessions the engine's session tracker already has the loaded
  // elapsed baked in — pick it up from engineStore so the timer reads correctly.
  useEffect(() => {
    return useEngineStore.subscribe((engineState, prev) => {
      if (engineState.phase === 'tracking' && prev.phase !== 'tracking' && statusRef.current === 'running') {
        // If continuing a session, initialise accumulated with the engine's reported elapsed
        if (engineState.sessionElapsed > 0) {
          accumulatedRef.current = engineState.sessionElapsed;
        }
        startTick();
      }
    });
  }, [startTick]);

  useEffect(() => () => clearTick(), [clearTick]);

  return (
    <TrackingContext.Provider value={{...state, start, continueSession, pause, resume, stop, reset}}>
      {children}
    </TrackingContext.Provider>
  );
}

export function useTracking(): TrackingContextValue {
  const ctx = useContext(TrackingContext);
  if (!ctx) throw new Error('useTracking must be used within TrackingProvider');
  return ctx;
}
