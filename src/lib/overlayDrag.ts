export interface OverlayDragPorts {
  moveBy:  (dx: number, dy: number) => void;
  dragEnd: () => void;
}

export interface OverlayDrag {
  /** Mousedown on the handle. A drag still open (its mouseup was missed) ends first. */
  start(screenX: number, screenY: number): void;
  /** Document mousemove. `buttons === 0` means the release happened unseen
   *  (outside the window) — the drag ends instead of moving. */
  move(screenX: number, screenY: number, buttons: number): void;
  /** Mouseup, window blur or handle unmount; idempotent. */
  end(): void;
}

/** Drag state for the overlay's handle: streams deltas to `moveBy` and sends
 *  exactly one `dragEnd` per drag that actually moved the window. */
export function createOverlayDrag(ports: OverlayDragPorts): OverlayDrag {
  let last: {x: number; y: number} | null = null;
  let moved = false;

  const end = () => {
    if (!last) return;
    last = null;
    if (moved) {
      moved = false;
      ports.dragEnd();
    }
  };

  return {
    start(screenX, screenY) {
      end();
      last = {x: screenX, y: screenY};
    },
    move(screenX, screenY, buttons) {
      if (!last) return;
      if (buttons === 0) { end(); return; }
      const dx = screenX - last.x;
      const dy = screenY - last.y;
      if (dx === 0 && dy === 0) return;
      last = {x: screenX, y: screenY};
      moved = true;
      ports.moveBy(dx, dy);
    },
    end,
  };
}
