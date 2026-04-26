import {BrowserWindow} from 'electron';
import type {ItemChangedPatch} from '@/types/electron';

/**
 * items:changed broadcaster.
 *
 * Both renderer windows hold their own Zustand itemsStore. To keep them in
 * sync without per-window IPC handshakes, every item-mutating IPC handler
 * in the main process fans an `items:changed` event out to every window.
 * Each window's itemsStore listener applies the patch.
 *
 * This is the single source of truth for "an item changed" — manual edits
 * (Items tab), auto price scrapes, name lookups, batch imports, and
 * automatic new-item discovery all funnel through here.
 */

let _getMainWindow:    () => BrowserWindow | null = () => null;
let _getTrackerWindow: () => BrowserWindow | null = () => null;

export function setItemBroadcastWindows(
  getMainWindow:    () => BrowserWindow | null,
  getTrackerWindow: () => BrowserWindow | null,
): void {
  _getMainWindow    = getMainWindow;
  _getTrackerWindow = getTrackerWindow;
}

export function broadcastItemsChanged(patch: ItemChangedPatch): void {
  _getMainWindow()?.webContents.send('items:changed', patch);
  _getTrackerWindow()?.webContents.send('items:changed', patch);
}
