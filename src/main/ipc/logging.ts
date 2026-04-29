import {app, ipcMain} from 'electron';
import {join} from 'path';
import {log} from '@/main/logger';

export function registerLoggingHandlers(): void {
  ipcMain.handle('logging:reload-config', () => { log.reloadConfig(); });
  ipcMain.handle('logging:get-log-path',  () => join(app.getPath('userData'), 'tli-tracker.log'));

  log.debug('ipc', 'Logging handlers registered');
}
