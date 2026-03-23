import {app, BrowserWindow, ipcMain, dialog} from 'electron';
import {join} from 'path';
import {existsSync} from 'fs';
import {initDb, settingsGetAll} from './db';
import {initLogger, log} from './logger';
import {registerDbHandlers} from './ipc/db';
import {registerOverlayHandlers} from './ipc/overlay';
import {registerEngineHandlers, stopEngineForShutdown} from './ipc/engine';

const DEV = !app.isPackaged;
const VITE_DEV_SERVER = 'http://localhost:5173';
const LOG_SUBPATH = join('TorchLight', 'Saved', 'Logs', 'UE_game.log');

let mainWindow: BrowserWindow | null = null;
let trackerWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    title: 'TLI Tracker',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (DEV) {
    mainWindow.loadURL(VITE_DEV_SERVER);
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  // Stop the engine before the window is destroyed so any active session auto-saves.
  mainWindow.on('close', () => {
    stopEngineForShutdown();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    trackerWindow?.close();
  });

  log.info('app', 'Main window created');
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

const TRACKER_DEFAULT_X  = 40;
const TRACKER_DEFAULT_Y  = 40;
const TRACKER_MIN_WIDTH  = 260;
const TRACKER_MIN_HEIGHT = 60;

function createTrackerWindow() {
  const settings = settingsGetAll();
  const x = parseInt(settings['tracker_window_x'] ?? '', 10);
  const y = parseInt(settings['tracker_window_y'] ?? '', 10);

  trackerWindow = new BrowserWindow({
    width:     320,
    height:    120,
    minWidth:  TRACKER_MIN_WIDTH,
    minHeight: TRACKER_MIN_HEIGHT,
    x: isNaN(x) ? TRACKER_DEFAULT_X : x,
    y: isNaN(y) ? TRACKER_DEFAULT_Y : y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (DEV) {
    trackerWindow.loadURL(`${VITE_DEV_SERVER}?window=overlay`);
  } else {
    trackerWindow.loadFile(join(__dirname, '../dist/index.html'), {query: {window: 'overlay'}});
  }

  trackerWindow.on('closed', () => {
    trackerWindow = null;
  });

  log.debug('app', 'Overlay window created');
}

// ---------------------------------------------------------------------------
// IPC — misc
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:pick-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {properties: ['openDirectory']});
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('fs:check-log-file', (_e, folder: string) => {
  return existsSync(join(folder, LOG_SUBPATH));
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  log.info('app', 'App starting');

  initDb();
  initLogger(settingsGetAll);

  registerDbHandlers();
  registerOverlayHandlers(
    () => trackerWindow,
    (w) => { trackerWindow = w; },
    createTrackerWindow,
  );
  registerEngineHandlers(
    () => mainWindow,
    () => trackerWindow,
  );

  // Logging IPC handlers
  ipcMain.handle('logging:reload-config', () => { log.reloadConfig(); });
  ipcMain.handle('logging:get-log-path',  () => join(app.getPath('userData'), 'tli-tracker.log'));

  log.debug('app', 'IPC handlers registered');

  createMainWindow();
});

app.on('window-all-closed', () => {
  log.info('app', 'App quitting');
  app.quit();
});
