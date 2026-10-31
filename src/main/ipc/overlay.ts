import {ipcMain, BrowserWindow} from 'electron';
import type {OverlayPosition} from '@/main/overlay-position';
import {log} from '@/main/logger';

export function registerOverlayHandlers(
  getTrackerWindow: () => BrowserWindow | null,
  createTrackerWindow: () => void,
  position: Pick<OverlayPosition, 'moveBy' | 'persist'>,
): void {
  let pendingShow = false;
  let sizedOnce   = false;

  ipcMain.on('overlay:show', () => {
    // A new window (first show, or after a crash give-up destroyed the last
    // one) shows once its renderer has sized it.
    if (!getTrackerWindow()) {
      createTrackerWindow();
      sizedOnce = false;
    }
    if (sizedOnce) {
      getTrackerWindow()?.show();
    } else {
      pendingShow = true;
    }
    log.debug('overlay', 'Overlay shown');
  });

  ipcMain.on('overlay:notify-ready', () => {
    sizedOnce = true;
    if (pendingShow) {
      pendingShow = false;
      getTrackerWindow()?.show();
    }
  });

  ipcMain.on('overlay:hide', () => {
    pendingShow = false;
    getTrackerWindow()?.hide();
    log.debug('overlay', 'Overlay hidden');
  });

  ipcMain.on('overlay:set-clickthrough', (_e, enabled: boolean) => {
    getTrackerWindow()?.setIgnoreMouseEvents(enabled);
    log.debug('overlay', `Overlay click-through: ${enabled}`);
  });

  // Per mousemove of a drag — only repositions; the drag's end persists once.
  ipcMain.on('overlay:move-by', (_e, dx: number, dy: number) => position.moveBy(dx, dy));

  ipcMain.on('overlay:drag-end', () => {
    position.persist();
    log.debug('overlay', 'Overlay position saved');
  });

  ipcMain.on('overlay:set-size', (_e, w: number, h: number) => {
    const win = getTrackerWindow();
    if (!win) return;
    // setBounds instead of setSize — on Windows, transparent + non-resizable
    // windows can fail to shrink via setSize alone (the window keeps its
    // previous larger footprint, eating clicks on empty space below it).
    const [x, y] = win.getPosition();
    win.setBounds({x, y, width: Math.round(w), height: Math.round(h)});
  });

  log.debug('ipc', 'Overlay handlers registered');
}
