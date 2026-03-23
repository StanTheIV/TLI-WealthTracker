import {useEffect, useRef, useState} from 'react';
import {useEngineStore} from '@/state/engineStore';
import TrackerPanel from '@/components/Dashboard/TrackerPanel';

export default function OverlayWindow() {
  const handleRef  = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragState  = useRef<{startX: number; startY: number} | null>(null);
  const [opacity, setOpacity] = useState(0.9);

  const sessionStatus = useEngineStore(s => s.sessionStatus);
  const enginePhase   = useEngineStore(s => s.phase);

  // Click-through when actively tracking, unless opacity is high enough to interact
  const isActivelyTracking = sessionStatus === 'running' && enginePhase === 'tracking';
  const clickThrough = isActivelyTracking && opacity <= 0.5;

  useEffect(() => {
    window.electronAPI.overlay.setClickThrough(clickThrough);
  }, [clickThrough]);

  // Load persisted opacity on mount
  useEffect(() => {
    window.electronAPI.db.settings.getAll().then((raw: Record<string, string>) => {
      if (raw.overlayOpacity) setOpacity(Number(raw.overlayOpacity));
    });
  }, []);

  // Drag via the top handle strip
  useEffect(() => {
    function isOverElement(el: HTMLElement | null, e: MouseEvent): boolean {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right &&
             e.clientY >= r.top  && e.clientY <= r.bottom;
    }

    const onMove = (e: MouseEvent) => {
      if (dragState.current) {
        const dx = e.screenX - dragState.current.startX;
        const dy = e.screenY - dragState.current.startY;
        dragState.current = {startX: e.screenX, startY: e.screenY};
        window.electronAPI.overlay.moveBy(dx, dy);
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (isOverElement(handleRef.current, e)) {
        dragState.current = {startX: e.screenX, startY: e.screenY};
      }
    };

    const onMouseUp = () => {
      dragState.current = null;
    };

    const removeOpacity = window.electronAPI.overlay.onOpacity(setOpacity);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      removeOpacity();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Resize window to match content height
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const observer = new ResizeObserver(([entry]) => {
      const height = Math.ceil(entry.borderBoxSize[0].blockSize);
      // Add 2px for border + 6px for drag strip
      const totalHeight = Math.max(height + 8, 60);
      window.electronAPI.overlay.setSize(320, totalHeight);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      style={{backgroundColor: `rgba(13,17,23,${opacity})`}}
      className="rounded-lg border border-border relative overflow-hidden"
    >
      {/* Drag strip — full-width, 6px tall, invisible by default */}
      <div
        ref={handleRef}
        className="absolute top-0 left-0 right-0 h-1.5 cursor-move hover:bg-white/10 transition-colors z-10"
      />

      {/* Content */}
      <div ref={contentRef} className="pt-2 pb-1">
        <TrackerPanel />
      </div>
    </div>
  );
}
