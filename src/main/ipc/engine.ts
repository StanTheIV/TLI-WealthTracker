import {ipcMain} from 'electron';
import {log} from '@/main/logger';
import type {TrackingService} from '@/main/tracking-service';
import type {FilterRule} from '@/shared/item-filter';
import {mechanic, type WindowedSeasonalType} from '@/shared/mechanics';

/** `engine:*` channels → TrackingService. Bindings only — the service owns all tracking state. */
export function registerEngineHandlers(tracking: TrackingService): void {
  // Each setting channel re-applies the whole table with its own key on top.
  const setWindow = (type: WindowedSeasonalType) => (_e: unknown, ms: number) =>
    tracking.reconfigure({[mechanic(type).window.settingKey]: String(ms)});

  ipcMain.on('engine:start',              ()                     => tracking.start());
  // handle, not on: a refused continue rejects the renderer's invoke.
  ipcMain.handle('engine:start-with-session', (_e, sessionId: string) => tracking.continueSession(sessionId));
  ipcMain.on('engine:stop',   () => tracking.stop());
  ipcMain.on('engine:pause',  () => tracking.pause());
  ipcMain.on('engine:resume', () => tracking.resume());
  ipcMain.on('engine:reset',  () => tracking.reset());
  // Item type changes arrive via `db:items:set-type`; main.ts wires that
  // handler's onItemTypeChanged to tracking.setItemType().
  ipcMain.on('engine:dismiss-material',        (_e, itemId: number) => tracking.dismissMaterial(itemId));
  ipcMain.on('engine:set-low-stock-threshold', (_e, n: number)      => tracking.reconfigure({lowStockThreshold: String(n)}));
  ipcMain.on('engine:set-overrealm-loot-ms',   setWindow('overrealm'));
  ipcMain.on('engine:set-carjack-loot-ms',     setWindow('carjack'));
  ipcMain.on('engine:set-clockwork-loot-ms',   setWindow('clockwork'));
  ipcMain.on('engine:set-lunaria-loot-ms',     setWindow('lunaria'));
  ipcMain.on('engine:set-sandlord-wave-ms',    setWindow('sandlord'));
  ipcMain.on('engine:set-hunting-loot-ms',     setWindow('hunting'));
  ipcMain.on('engine:set-afterlight-loot-ms',  setWindow('afterlight'));
  ipcMain.on('engine:update-filter-rules',     (_e, rules: FilterRule[] | null) => tracking.setFilterRules(rules));

  log.debug('ipc', 'Engine handlers registered');
}
