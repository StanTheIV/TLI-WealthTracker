import {ipcMain, type BrowserWindow} from 'electron';
import {app} from 'electron';
import {checkForUpdate, downloadUpdate, launchInstallerAndQuit, fetchChangelog} from '../updater';
import {settingsGet, settingsSet} from '../db';
import {log} from '../logger';

function isNewer(current: string, last: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const c = parse(current);
  const l = parse(last);
  for (let i = 0; i < 3; i++) {
    if ((c[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((c[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

export function registerUpdaterHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('updater:check', async () => {
    // Skip auto-update for portable builds
    if (process.env.PORTABLE_EXECUTABLE_DIR) return null;
    return checkForUpdate();
  });

  ipcMain.handle('updater:download', async () => {
    try {
      const info = await checkForUpdate();
      if (!info) return {success: false, error: 'No update available'};

      const dest = await downloadUpdate(info.downloadUrl, (pct) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('updater:progress', pct);
        }
      });

      return {success: true, path: dest};
    } catch (err) {
      log.error('update', `Download failed: ${err}`);
      return {success: false, error: String(err)};
    }
  });

  ipcMain.on('updater:install', (_e, installerPath: string) => {
    launchInstallerAndQuit(installerPath);
  });

  ipcMain.handle('updater:get-changelog', async () => {
    const current = app.getVersion();
    const lastSeen = settingsGet('last_seen_version') ?? '0.0.0';

    if (!isNewer(current, lastSeen)) return null;

    const changelog = await fetchChangelog(current);
    if (!changelog) return null;

    return {version: `v${current}`, changelog};
  });

  ipcMain.handle('updater:dismiss-changelog', () => {
    settingsSet('last_seen_version', app.getVersion());
  });
}
