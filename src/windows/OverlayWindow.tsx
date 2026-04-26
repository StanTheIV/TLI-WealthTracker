import {useEffect, useRef, useState} from 'react';
import {useEngineStore} from '@/state/engineStore';
import {useSettingsStore, type RateTimeframe} from '@/state/settingsStore';
import TrackerPanel from '@/components/Dashboard/TrackerPanel';

export default function OverlayWindow() {
  const contentRef = useRef<HTMLDivElement>(null);
  const dragState  = useRef<{startX: number; startY: number} | null>(null);
  const [opacity, setOpacity]       = useState(0.9);
  const [clickThroughWhileRunning, setClickThroughWhileRunning] = useState(false);
  const [handleHovered, setHandleHovered] = useState(false);

  const sessionStatus = useEngineStore(s => s.sessionStatus);
  const enginePhase   = useEngineStore(s => s.phase);

  const isActivelyTracking = sessionStatus === 'running' && enginePhase === 'tracking';
  const clickThrough       = isActivelyTracking && clickThroughWhileRunning;

  useEffect(() => {
    window.electronAPI.overlay.setClickThrough(clickThrough);
  }, [clickThrough]);

  useEffect(() => {
    window.electronAPI.db.settings.getAll().then((raw: Record<string, string>) => {
      if (raw.overlayOpacity)           setOpacity(Number(raw.overlayOpacity));
      if (raw.clickThroughWhileRunning) setClickThroughWhileRunning(raw.clickThroughWhileRunning === 'true');
      if (raw.pauseTotalTimerInTown !== undefined) {
        useSettingsStore.setState({pauseTotalTimerInTown: raw.pauseTotalTimerInTown === 'true'});
      }
    });
  }, []);

  // Keep settings in sync when the main window changes them
  useEffect(() => {
    return window.electronAPI.overlay.onSettingChange((key, value) => {
      if (key === 'rateTimeframe' && (value === 'hour' || value === 'minute')) {
        useSettingsStore.setState({rateTimeframe: value as RateTimeframe});
      }
      if (key === 'clickThroughWhileRunning') {
        setClickThroughWhileRunning(value === 'true');
      }
      if (key === 'pauseTotalTimerInTown') {
        useSettingsStore.setState({pauseTotalTimerInTown: value === 'true'});
      }
    });
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragState.current) {
        const dx = e.screenX - dragState.current.startX;
        const dy = e.screenY - dragState.current.startY;
        dragState.current = {startX: e.screenX, startY: e.screenY};
        window.electronAPI.overlay.moveBy(dx, dy);
      }
    };
    const onMouseUp = () => { dragState.current = null; };

    const removeOpacity = window.electronAPI.overlay.onOpacity(setOpacity);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      removeOpacity();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Resize window to match content height
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    let notified = false;
    const applySize = (height: number) => {
      const totalHeight = Math.max(height, 60);
      window.electronAPI.overlay.setSize(360, totalHeight);
      if (!notified) {
        notified = true;
        window.electronAPI.overlay.notifyReady();
      }
    };

    const observer = new ResizeObserver(([entry]) => {
      applySize(Math.ceil(entry.borderBoxSize[0].blockSize));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      style={{
        backgroundColor: `rgba(13,17,23,${opacity})`,
        '--card-opacity': String(0.5 + opacity * 0.5),
      } as React.CSSProperties}
      className="rounded-xl border border-white/8 relative overflow-hidden shadow-2xl"
      ref={contentRef}
    >
      {/* Drag handle strip */}
      <div
        className="flex items-center justify-center h-6 cursor-move transition-colors hover:bg-white/6"
        onMouseDown={e => { dragState.current = {startX: e.screenX, startY: e.screenY}; }}
        onMouseEnter={() => setHandleHovered(true)}
        onMouseLeave={() => setHandleHovered(false)}
      >
        <div className={`flex gap-1 transition-opacity duration-200 ${handleHovered ? 'opacity-60' : 'opacity-20'}`}>
          <span className="w-1 h-1 rounded-full bg-text-secondary" />
          <span className="w-1 h-1 rounded-full bg-text-secondary" />
          <span className="w-1 h-1 rounded-full bg-text-secondary" />
          <span className="w-1 h-1 rounded-full bg-text-secondary" />
          <span className="w-1 h-1 rounded-full bg-text-secondary" />
        </div>
      </div>

      {/* Thin separator under handle */}
      <div className="h-px bg-white/5 mx-2" />

      <TrackerPanel />
    </div>
  );
}
