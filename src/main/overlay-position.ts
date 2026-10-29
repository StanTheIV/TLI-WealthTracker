/** Settings keys holding the overlay's last persisted top-left corner. Main-only:
 *  no renderer reads them, so they're written straight to the store (no broadcast). */
const KEY_X = 'tracker_window_x';
const KEY_Y = 'tracker_window_y';

export interface OverlayPositionDeps {
  /** The overlay's current position, or null when it doesn't exist / is destroyed. */
  getPosition: () => readonly [number, number] | null;
  setPosition: (x: number, y: number) => void;
  settingsSet: (key: string, value: string) => void;
}

/**
 * A drag streams `moveBy` per mousemove, which only repositions the window. The
 * position is written once — on the renderer's drag-end, and as a safety net on
 * close — always from the window's CURRENT position, never renderer coordinates.
 */
export class OverlayPosition {
  private readonly _deps: OverlayPositionDeps;

  constructor(deps: OverlayPositionDeps) {
    this._deps = deps;
  }

  /** Shifts the overlay by (dx, dy). A non-finite delta is ignored. */
  moveBy(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const pos = this._deps.getPosition();
    if (!pos) return;
    this._deps.setPosition(Math.round(pos[0] + dx), Math.round(pos[1] + dy));
  }

  /** Writes the overlay's current position; a no-op when there is no overlay.
   *  Unvalidated — the restore-time visibility check guards a stale position. */
  persist(): void {
    const pos = this._deps.getPosition();
    if (!pos) return;
    this._deps.settingsSet(KEY_X, String(pos[0]));
    this._deps.settingsSet(KEY_Y, String(pos[1]));
  }
}

/** The persisted overlay position, or null when unset, unparseable or not on
 *  any display (`isVisible` false) — the caller then uses its default corner. */
export function readSavedOverlayPosition(
  settings: Record<string, string>,
  isVisible: (x: number, y: number) => boolean,
): {x: number; y: number} | null {
  const x = parseInt(settings[KEY_X] ?? '', 10);
  const y = parseInt(settings[KEY_Y] ?? '', 10);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return isVisible(x, y) ? {x, y} : null;
}
