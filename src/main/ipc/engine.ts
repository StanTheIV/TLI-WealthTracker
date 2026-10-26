import {ipcMain} from 'electron';
import {log} from '@/main/logger';
import type {TrackingService} from '@/main/tracking-service';
import type {FilterRule} from '@/shared/item-filter';

/** `engine:*` channels → TrackingService. Bindings only — the service owns all tracking state. */
export function registerEngineHandlers(tracking: TrackingService): void {
  ipcMain.on('engine:start',              ()                     => tracking.start());
  ipcMain.on('engine:start-with-session', (_e, sessionId: string) => tracking.continueSession(sessionId));
  ipcMain.on('engine:stop',   () => tracking.stop());
  ipcMain.on('engine:pause',  () => tracking.pause());
  ipcMain.on('engine:resume', () => tracking.resume());
  ipcMain.on('engine:reset',  () => tracking.reset());
  // Item type changes arrive via `db:items:set-type`; main.ts wires that
  // handler's onItemTypeChanged to tracking.setItemType().
  ipcMain.on('engine:dismiss-material',        (_e, itemId: number) => tracking.dismissMaterial(itemId));
  ipcMain.on('engine:set-low-stock-threshold', (_e, n: number)      => tracking.setLowStockThreshold(n));
  ipcMain.on('engine:set-overrealm-loot-ms',   (_e, ms: number)     => tracking.setOverrealmLootDurationMs(ms));
  ipcMain.on('engine:set-carjack-loot-ms',     (_e, ms: number)     => tracking.setCarjackLootDurationMs(ms));
  ipcMain.on('engine:set-clockwork-loot-ms',   (_e, ms: number)     => tracking.setClockworkLootDurationMs(ms));
  ipcMain.on('engine:set-lunaria-loot-ms',     (_e, ms: number)     => tracking.setLunariaLootDurationMs(ms));
  ipcMain.on('engine:set-sandlord-wave-ms',    (_e, ms: number)     => tracking.setSandlordWaveDurationMs(ms));
  ipcMain.on('engine:set-hunting-loot-ms',     (_e, ms: number)     => tracking.setHuntingLootDurationMs(ms));
  ipcMain.on('engine:set-afterlight-loot-ms',  (_e, ms: number)     => tracking.setAfterlightLootDurationMs(ms));
  ipcMain.on('engine:update-filter-rules',     (_e, rules: FilterRule[] | null) => tracking.setFilterRules(rules));

  log.debug('ipc', 'Engine handlers registered');
}
