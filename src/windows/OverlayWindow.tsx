import {useEffect, useRef, useState} from 'react';
import {selectRunStatus, useEngineStore} from '@/state/engineStore';
import {useSettingsStore} from '@/state/settingsStore';
import TrackerPanel from '@/components/Dashboard/TrackerPanel';
import {createOverlayDrag, type OverlayDrag} from '@/lib/overlayDrag';

export default function OverlayWindow() {
  const contentRef = useRef<HTMLDivElement>(null);
  const [drag] = useState(() => createOverlayDrag({
    moveBy:  (dx, dy) => window.electronAPI.overlay.moveBy(dx, dy),
    dragEnd: () => window.electronAPI.overlay.dragEnd(),
  }));

  const opacity                  = useSettingsStore(s => s.overlayOpacity);
  const clickThroughWhileRunning = useSettingsStore(s => s.clickThroughWhileRunning);
  const isActivelyTracking       = useEngineStore(s => selectRunStatus(s) === 'running');
  const clickThrough       = isActivelyTracking && clickThroughWhileRunning;

  useEffect(() => {
    window.electronAPI.overlay.setClickThrough(clickThrough);
  }, [clickThrough]);

  // Load the settings and follow every change made in the main window.
  useEffect(() => {
    void useSettingsStore.getState().init();
  }, []);

  // A release the document never sees (outside the window, focus lost) must
  // still end the drag, or the overlay keeps following the cursor.
  useEffect(() => {
    const onMove = (e: MouseEvent) => drag.move(e.screenX, e.screenY, e.buttons);
    const onEnd  = () => drag.end();

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    window.addEventListener('blur', onEnd);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      window.removeEventListener('blur', onEnd);
      drag.end();
    };
  }, [drag]);

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

  // While tracking, the window itself goes fully transparent so only the cards
  // float over the game — the opacity setting governs the cards, not the pane
  // behind them. Idle/paused keeps the pane so the overlay stays findable.
  const chromeVisible = !isActivelyTracking;

  return (
    <div
      style={{
        backgroundColor: chromeVisible ? `rgba(13,17,23,${opacity})` : 'transparent',
        '--card-opacity': String(0.5 + opacity * 0.5),
      } as React.CSSProperties}
      className={`rounded-xl relative overflow-hidden transition-colors duration-200
        ${chromeVisible ? 'border border-white/8 shadow-2xl' : 'border border-transparent'}`}
      ref={contentRef}
    >
      {/* Drag handle strip — hidden while tracking, along with the pane it sits on */}
      {chromeVisible && (
        <>
          <DragHandle drag={drag} />
          <div className="h-px bg-white/5 mx-2" />
        </>
      )}

      <TrackerPanel />
    </div>
  );
}

function DragHandle({drag}: {drag: OverlayDrag}) {
  const [hovered, setHovered] = useState(false);

  // Starting a session hides the handle mid-drag: end it with the handle.
  useEffect(() => () => drag.end(), [drag]);

  return (
    <div
      className="flex items-center justify-center h-6 cursor-move transition-colors hover:bg-white/6"
      onMouseDown={e => drag.start(e.screenX, e.screenY)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`flex gap-1 transition-opacity duration-200 ${hovered ? 'opacity-60' : 'opacity-20'}`}>
        <span className="w-1 h-1 rounded-full bg-text-secondary" />
        <span className="w-1 h-1 rounded-full bg-text-secondary" />
        <span className="w-1 h-1 rounded-full bg-text-secondary" />
        <span className="w-1 h-1 rounded-full bg-text-secondary" />
        <span className="w-1 h-1 rounded-full bg-text-secondary" />
      </div>
    </div>
  );
}
