import {ipcMain} from 'electron';
import {log} from '@/main/logger';
import type {SettingsService} from '@/main/settings-service';

/** `settings:*` channels → SettingsService. `handle`, so a failed persist rejects the renderer's invoke. */
export function registerSettingsHandlers(settings: SettingsService): void {
  ipcMain.handle('settings:get-all', ()                                 => settings.getAll());
  ipcMain.handle('settings:set',     (_e, key: string, value: string)   => settings.set(key, value));

  log.debug('ipc', 'Settings handlers registered');
}
