import {ipcMain, type BrowserWindow} from 'electron';
import {app} from 'electron';
import {checkForUpdate, downloadUpdate, launchInstallerAndQuit, fetchChangelog, isNewer} from '../updater';
import {settingsGet, settingsSet} from '../db';
import {log} from '../logger';
import {describeError, describeErrorBrief} from '@/shared/describe-error';
import type {UpdateInfo} from '@/shared/contracts/api';

export function registerUpdaterHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('updater:check', async (): Promise<UpdateInfo | null> => {
    // Skip auto-update for portable builds
    if (process.env.PORTABLE_EXECUTABLE_DIR) return null;
    const update = await checkForUpdate();
    if (!update) return null;
    return {version: update.version, changelog: update.changelog, downloadUrl: update.downloadUrl};
  });

  ipcMain.handle('updater:download', async () => {
    try {
      const update = await checkForUpdate();
      if (!update) return {success: false, error: 'No update available'};

      await downloadUpdate(update, (pct) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('updater:progress', pct);
        }
      });

      return {success: true};
    } catch (err) {
      log.error('update', `Download failed: ${describeError(err)}`);
      return {success: false, error: describeErrorBrief(err)};
    }
  });

  // Takes no argument: main opens only the installer it downloaded and verified.
  ipcMain.on('updater:install', () => {
    void launchInstallerAndQuit();
  });

  ipcMain.handle('updater:get-changelog', async () => {
    const current = app.getVersion();
    const lastSeen = settingsGet('last_seen_version') ?? '0.0.0';

    if (!isNewer(lastSeen, current)) return null;

    const changelog = await fetchChangelog(current);
    if (!changelog) return null;

    return {version: `v${current}`, changelog};
  });

  ipcMain.handle('updater:dismiss-changelog', () => {
    settingsSet('last_seen_version', app.getVersion());
  });
}
