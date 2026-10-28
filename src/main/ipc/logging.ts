import {ipcMain} from 'electron';
import {getLogFilePath, log} from '@/main/logger';

export function registerLoggingHandlers(): void {
  ipcMain.handle('logging:get-log-path', () => getLogFilePath());

  log.debug('ipc', 'Logging handlers registered');
}
