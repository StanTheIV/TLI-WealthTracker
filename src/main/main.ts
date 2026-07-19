import {app, BrowserWindow, ipcMain, dialog, Menu, screen} from 'electron';
import {join} from 'path';
import {existsSync, readFileSync} from 'fs';
import {initDb, itemsCount, itemsImportBatch, settingsGetAll, settingsSet} from './db';
import {initLogger, log} from './logger';
import type {DbItem} from './db';
import {registerDbHandlers} from './ipc/db';
import {registerOverlayHandlers} from './ipc/overlay';
import {registerEngineHandlers, stopEngineForShutdown, notifyEngineItemTypeChanged} from './ipc/engine';
import {registerUpdaterHandlers} from './ipc/updater';
import {registerLoggingHandlers} from './ipc/logging';

const DEV = !app.isPackaged;
const VITE_DEV_SERVER = 'http://localhost:5173';

// Dev-only: expose Chrome DevTools Protocol so tooling (e.g. the Electron MCP
// server) can attach to inspect the DOM, run renderer JS, and take screenshots.
// Gated to DEV so a debugging port never ships in packaged builds.
if (DEV) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}
const LOG_SUBPATH = join('TorchLight', 'Saved', 'Logs', 'UE_game.log');

let mainWindow: BrowserWindow | null = null;
let trackerWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

const MAIN_MIN_WIDTH  = 800;
const MAIN_MIN_HEIGHT = 560;

/** True when the rect overlaps at least one display's work area — a saved
 *  position on a since-disconnected monitor fails this and falls back. */
function boundsVisibleOnSomeDisplay(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some(({workArea}) =>
    x < workArea.x + workArea.width &&
    x + width > workArea.x &&
    y < workArea.y + workArea.height &&
    y + height > workArea.y,
  );
}

/** Last-closed main-window bounds from settings, or null when unset/off-screen. */
function readSavedMainBounds(settings: Record<string, string>) {
  const x      = parseInt(settings['main_window_x']      ?? '', 10);
  const y      = parseInt(settings['main_window_y']      ?? '', 10);
  const width  = parseInt(settings['main_window_width']  ?? '', 10);
  const height = parseInt(settings['main_window_height'] ?? '', 10);
  if ([x, y, width, height].some(Number.isNaN)) return null;
  if (!boundsVisibleOnSomeDisplay(x, y, width, height)) return null;
  return {x, y, width: Math.max(width, MAIN_MIN_WIDTH), height: Math.max(height, MAIN_MIN_HEIGHT)};
}

function createMainWindow() {
  const settings = settingsGetAll();
  const saved    = readSavedMainBounds(settings);

  mainWindow = new BrowserWindow({
    width:  saved?.width  ?? 1100,
    height: saved?.height ?? 720,
    // Omitting x/y lets Electron center the window (first run / monitor gone).
    ...(saved ? {x: saved.x, y: saved.y} : {}),
    minWidth: MAIN_MIN_WIDTH,
    minHeight: MAIN_MIN_HEIGHT,
    title: 'TLI Tracker',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (settings['main_window_maximized'] === 'true') mainWindow.maximize();

  if (DEV) {
    mainWindow.loadURL(VITE_DEV_SERVER);
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  // Stop the engine before the window is destroyed so any active session
  // auto-saves; persist bounds so the next launch reopens in the same spot
  // (normal bounds even when closing maximized).
  mainWindow.on('close', () => {
    if (mainWindow) {
      const b = mainWindow.getNormalBounds();
      settingsSet('main_window_x',         String(b.x));
      settingsSet('main_window_y',         String(b.y));
      settingsSet('main_window_width',     String(b.width));
      settingsSet('main_window_height',    String(b.height));
      settingsSet('main_window_maximized', mainWindow.isMaximized() ? 'true' : 'false');
    }
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
  // Same monitor-gone fallback as the main window: a saved overlay position on
  // a disconnected display reverts to the default corner.
  const savedPosValid = !isNaN(x) && !isNaN(y) && boundsVisibleOnSomeDisplay(x, y, 360, 200);

  trackerWindow = new BrowserWindow({
    width:     360,
    height:    200,
    minWidth:  TRACKER_MIN_WIDTH,
    minHeight: TRACKER_MIN_HEIGHT,
    x: savedPosValid ? x : TRACKER_DEFAULT_X,
    y: savedPosValid ? y : TRACKER_DEFAULT_Y,
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
// Seed
// ---------------------------------------------------------------------------

function seedItemsIfEmpty(): void {
  if (itemsCount() > 0) return;

  const seedPath = app.isPackaged
    ? join(process.resourcesPath, 'full_table.json')
    : join(app.getAppPath(), 'public', 'full_table.json');

  if (!existsSync(seedPath)) {
    log.warn('database', 'Seed file not found, skipping auto-import');
    return;
  }

  try {
    const raw = JSON.parse(readFileSync(seedPath, 'utf-8')) as Record<string, {name: string; type: string; price: number; last_update: number}>;
    const items: DbItem[] = Object.entries(raw).map(([id, v]) => ({
      id,
      name: v.name,
      type: v.type || 'other',
      price: v.price ?? 0,
      priceDate: v.last_update ?? 0,
    }));
    const count = itemsImportBatch(items);
    log.info('database', `Auto-seeded ${count} items from full_table.json`);
  } catch (err) {
    log.error('database', `Failed to seed items: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  log.info('app', 'App starting');

  initDb();
  seedItemsIfEmpty();
  initLogger(settingsGetAll);

  registerDbHandlers({
    getMainWindow:    () => mainWindow,
    getTrackerWindow: () => trackerWindow,
    onItemTypeChanged: (id, type) => notifyEngineItemTypeChanged(id, type),
  });
  registerOverlayHandlers(
    () => trackerWindow,
    (w) => { trackerWindow = w; },
    createTrackerWindow,
  );
  registerEngineHandlers(
    () => mainWindow,
    () => trackerWindow,
  );
  registerUpdaterHandlers(() => mainWindow);
  registerLoggingHandlers();

  log.debug('app', 'IPC handlers registered');

  createMainWindow();
});

app.on('window-all-closed', () => {
  log.info('app', 'App quitting');
  app.quit();
});
