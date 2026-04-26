import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';

interface Props {
  /** Fired only after the user holds for `holdMs` without releasing. */
  onConfirm:    () => void;
  /** Hold duration in ms before firing. Default 2000. */
  holdMs?:      number;
  /** Diameter in px of the circular button. Default 36 (matches w-9 h-9). */
  size?:        number;
  /** Tailwind classes for the inner button content (icon color, bg, hover). */
  className?:   string;
  /** Tailwind class controlling the progress arc stroke colour. */
  ringClass?:   string;
  title?:       string;
  ariaLabel?:   string;
  children:     ReactNode;
}

/**
 * Hold-to-confirm button. Renders an SVG progress ring around its content
 * that fills clockwise as the user holds the pointer down, and only fires
 * onConfirm when the hold reaches holdMs.
 *
 * Releasing early cancels and rewinds the ring. Pointer leaving the button
 * while held also cancels.
 */
export default function HoldButton({
  onConfirm,
  holdMs    = 2000,
  size      = 36,
  className = '',
  ringClass = 'stroke-gold',
  title,
  ariaLabel,
  children,
}: Props) {
  const [progress, setProgress] = useState(0); // 0 → 1
  const startedAtRef = useRef<number | null>(null);
  const rafRef       = useRef<number | null>(null);

  const STROKE = 2;
  const radius = size / 2 - STROKE / 2;
  const circ   = 2 * Math.PI * radius;

  const cancelRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const release = useCallback(() => {
    cancelRaf();
    startedAtRef.current = null;
    setProgress(0);
  }, [cancelRaf]);

  const begin = useCallback(() => {
    startedAtRef.current = performance.now();
    const tick = (now: number) => {
      if (startedAtRef.current === null) return;
      const elapsed = now - startedAtRef.current;
      const p       = Math.min(elapsed / holdMs, 1);
      setProgress(p);
      if (p >= 1) {
        startedAtRef.current = null;
        rafRef.current       = null;
        onConfirm();
        // Brief full-ring flash before snapping back so the user gets feedback.
        setTimeout(() => setProgress(0), 180);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [holdMs, onConfirm]);

  // Cleanup on unmount.
  useEffect(() => () => cancelRaf(), [cancelRaf]);

  const dashOffset = circ * (1 - progress);

  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel ?? title}
      onPointerDown={(e) => { e.preventDefault(); begin(); }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      className={`relative flex items-center justify-center transition-colors ${className}`}
      style={{width: size, height: size, borderRadius: '9999px'}}
    >
      {/* Progress ring overlay */}
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 pointer-events-none"
        style={{transform: 'rotate(-90deg)'}}
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dashOffset}
          className={ringClass}
          style={{transition: progress === 0 ? 'stroke-dashoffset 180ms ease-out' : 'none'}}
        />
      </svg>

      <span className="relative z-[1] flex items-center justify-center">
        {children}
      </span>
    </button>
  );
}
