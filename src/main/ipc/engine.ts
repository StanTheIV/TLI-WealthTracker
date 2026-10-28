import {ipcMain} from 'electron';
import {log} from '@/main/logger';
import type {TrackingService} from '@/main/tracking-service';
import type {FilterRule} from '@/shared/item-filter';

/** `engine:*` channels → TrackingService. Bindings only — the service owns all tracking state. */
export function registerEngineHandlers(tracking: TrackingService): void {
  ipcMain.on('engine:start',              ()                     => tracking.start());
  // handle, not on: a refused continue rejects the renderer's invoke.
  ipcMain.handle('engine:start-with-session', (_e, sessionId: string) => tracking.continueSession(sessionId));
  ipcMain.on('engine:stop',   () => tracking.stop());
  ipcMain.on('engine:pause',  () => tracking.pause());
  ipcMain.on('engine:resume', () => tracking.resume());
  ipcMain.on('engine:reset',  () => tracking.reset());
  // Item type changes arrive via `db:items:set-type`; main.ts wires that
  // handler's onItemTypeChanged to tracking.setItemType(). Engine settings
  // arrive via `settings:set` (SettingsService → tracking.reconfigure()).
  ipcMain.on('engine:dismiss-material',        (_e, itemId: number) => tracking.dismissMaterial(itemId));
  ipcMain.on('engine:update-filter-rules',     (_e, rules: FilterRule[] | null) => tracking.setFilterRules(rules));

  log.debug('ipc', 'Engine handlers registered');
}
