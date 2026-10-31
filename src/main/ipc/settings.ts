import {ipcMain} from 'electron';
import {log} from '@/main/logger';
import type {SerperKey} from '@/main/serper-key';
import type {SettingsService} from '@/main/settings-service';

/** `settings:*` channels → SettingsService, `settings:serper:*` → SerperKey (never
 *  the value). `handle`, so a failed write rejects the renderer's invoke. */
export function registerSettingsHandlers(
  settings: SettingsService,
  serperKey: Pick<SerperKey, 'has' | 'set' | 'clear'>,
): void {
  ipcMain.handle('settings:get-all', ()                                 => settings.getAll());
  ipcMain.handle('settings:set',     (_e, key: string, value: string)   => settings.set(key, value));

  ipcMain.handle('settings:serper:has',   ()                => serperKey.has());
  ipcMain.handle('settings:serper:set',   (_e, key: string) => serperKey.set(key));
  ipcMain.handle('settings:serper:clear', ()                => serperKey.clear());

  log.debug('ipc', 'Settings handlers registered');
}
