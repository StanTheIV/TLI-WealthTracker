import {createContext, useContext, useEffect, useId, useRef, type ReactNode} from 'react';
import {modalStack} from './modalStack';

interface Props {
  children: ReactNode;
  /** Escape calls it (topmost modal only). Omit it for a dialog that cannot be dismissed. */
  onClose?: () => void;
  /** A press on the backdrop (outside the card) calls `onClose` too. */
  closeOnBackdrop?: boolean;
  /** Card sizing / padding / layout; the surface, border and radius are the Modal's. */
  className?: string;
}

const TitleIdContext = createContext<string | undefined>(undefined);

/** The dialog's heading — the Modal's `aria-labelledby` points at it. */
export function ModalTitle({className, children}: {className?: string; children: ReactNode}) {
  const id = useContext(TitleIdContext);
  return <h2 id={id} className={className}>{children}</h2>;
}

/**
 * Backdrop + card, `role="dialog"` labelled by its `ModalTitle`. Focus moves onto
 * the card on open and back to its previous owner on close (no trap).
 */
export default function Modal({children, onClose, closeOnBackdrop = false, className = ''}: Props) {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const id = Symbol('modal');
    modalStack.push(id);

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !modalStack.isTop(id)) return;
      const close = onCloseRef.current;
      if (!close) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      modalStack.remove(id);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={e => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`bg-surface border border-border rounded-xl shadow-2xl outline-none ${className}`}
      >
        <TitleIdContext.Provider value={titleId}>{children}</TitleIdContext.Provider>
      </div>
    </div>
  );
}
