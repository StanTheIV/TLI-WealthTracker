import {ipcMain} from 'electron';
import {log} from '@/main/logger';
import type {TrackingService} from '@/main/tracking-service';

/** `engine:*` channels → TrackingService. Bindings only — the service owns all tracking state. */
export function registerEngineHandlers(tracking: TrackingService): void {
  // handle, not on: a failed start / reset or a refused continue rejects the renderer's invoke.
  ipcMain.handle('engine:start',              ()                     => tracking.start());
  ipcMain.handle('engine:start-with-session', (_e, sessionId: string) => tracking.continueSession(sessionId));
  ipcMain.handle('engine:reset',              ()                     => tracking.reset());
  ipcMain.on('engine:stop',   () => tracking.stop());
  ipcMain.on('engine:pause',  () => tracking.pause());
  ipcMain.on('engine:resume', () => tracking.resume());
  // A loading window's catch-up: the replay plus the seq it was taken at.
  ipcMain.handle('engine:get-state', () => tracking.getState());
  // Item type changes arrive via `db:items:set-type`; main.ts wires that
  // handler's onItemTypeChanged to tracking.setItemType(). Engine settings
  // arrive via `settings:set` (SettingsService → tracking.reconfigure()), the
  // filter via every `db:filters:*` write (onFiltersChanged →
  // tracking.applyActiveFilter()).
  ipcMain.on('engine:dismiss-material',        (_e, itemId: number) => tracking.dismissMaterial(itemId));

  log.debug('ipc', 'Engine handlers registered');
}
