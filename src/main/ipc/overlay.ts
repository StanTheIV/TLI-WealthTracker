import {ipcMain, BrowserWindow} from 'electron';
import {settingsSet} from '@/main/db';
import {log} from '@/main/logger';

export function registerOverlayHandlers(
  getTrackerWindow: () => BrowserWindow | null,
  setTrackerWindow: (w: BrowserWindow | null) => void,
  createTrackerWindow: () => void,
): void {
  ipcMain.on('overlay:show', () => {
    if (!getTrackerWindow()) createTrackerWindow();
    getTrackerWindow()?.show();
    log.debug('overlay', 'Overlay shown');
  });

  ipcMain.on('overlay:hide', () => {
    getTrackerWindow()?.hide();
    log.debug('overlay', 'Overlay hidden');
  });

  ipcMain.on('overlay:set-clickthrough', (_e, enabled: boolean) => {
    getTrackerWindow()?.setIgnoreMouseEvents(enabled);
    log.debug('overlay', `Overlay click-through: ${enabled}`);
  });

  ipcMain.on('overlay:set-position', (_e, x: number, y: number) => {
    getTrackerWindow()?.setPosition(Math.round(x), Math.round(y));
  });

  ipcMain.on('overlay:set-opacity', (_e, v: number) => {
    getTrackerWindow()?.webContents.send('overlay:opacity', v);
    log.debug('overlay', `Overlay opacity: ${v}`);
  });

  ipcMain.on('settings:broadcast', (_e, key: string, value: string) => {
    getTrackerWindow()?.webContents.send('settings:change', key, value);
  });

  ipcMain.on('overlay:move-by', (_e, dx: number, dy: number) => {
    const win = getTrackerWindow();
    if (!win) return;
    const [x, y] = win.getPosition();
    const nx = Math.round(x + dx);
    const ny = Math.round(y + dy);
    win.setPosition(nx, ny);
    settingsSet('tracker_window_x', String(nx));
    settingsSet('tracker_window_y', String(ny));
    log.debug('overlay', `Overlay position: (${nx}, ${ny})`);
  });

  ipcMain.handle('overlay:get-position', () => {
    const win = getTrackerWindow();
    if (!win) return {x: 0, y: 0};
    const [x, y] = win.getPosition();
    return {x, y};
  });

  ipcMain.on('overlay:set-size', (_e, w: number, h: number) => {
    getTrackerWindow()?.setSize(Math.round(w), Math.round(h));
  });

  log.debug('ipc', 'Overlay handlers registered');
}
