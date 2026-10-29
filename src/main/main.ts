import {app, BrowserWindow, ipcMain, dialog, Menu, screen} from 'electron';
import {join} from 'path';
import {existsSync, readFileSync} from 'fs';
import {
  initDb, itemsCount, itemsImportBatch, itemsGetAll, itemsGetLocked, itemsInsertIfMissing, priceRecord,
  filtersGetAll, settingsGetAll, settingsSet, wealthInsert, wealthGetRange, wealthGetRangeHeads, wealthGetLatest,
} from './db';
import {backupDb} from './db/backup';
import {openBetterSqlite3} from './db/drivers/better-sqlite3';
import {newerSchemaMessage} from './db/schema-newer';
import {SqliteSessionStore} from './db/session-store';
import type {SqlConn} from './db/sql-conn';
import {initLogger, log} from './logger';
import type {DbItem} from '@/shared/contracts/db';
import {registerDbHandlers} from './ipc/db';
import {registerOverlayHandlers} from './ipc/overlay';
import {registerEngineHandlers} from './ipc/engine';
import {registerUpdaterHandlers} from './ipc/updater';
import {registerLoggingHandlers} from './ipc/logging';
import {registerSettingsHandlers} from './ipc/settings';
import {initLeaguesAndPriceHistory} from './leagues-sync';
import {SettingsService} from './settings-service';
import {TrackingService} from './tracking-service';
import {closeCrashedSessions} from './session-recovery';
import {createEngine} from './engine/create-engine';
import {WorkerProcess} from './worker-process';
import {WealthRecorder} from './wealth-recorder';
import {WealthSeries} from './wealth-series';
import {OverlayPosition, readSavedOverlayPosition} from './overlay-position';
import {LOG_FILENAME, LOG_SUBPATH} from '@/shared/paths';

const DEV = !app.isPackaged;
const VITE_DEV_SERVER = 'http://localhost:5173';

// Dev-only: expose Chrome DevTools Protocol so tooling (e.g. the Electron MCP
// server) can attach to inspect the DOM, run renderer JS, and take screenshots.
// Gated to DEV so a debugging port never ships in packaged builds.
if (DEV) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

let mainWindow: BrowserWindow | null = null;
let trackerWindow: BrowserWindow | null = null;

/** The overlay's live window — null before its first show and once closed. */
function liveTrackerWindow(): BrowserWindow | null {
  return trackerWindow && !trackerWindow.isDestroyed() ? trackerWindow : null;
}

const overlayPosition = new OverlayPosition({
  getPosition: () => {
    const win = liveTrackerWindow();
    if (!win) return null;
    const [x, y] = win.getPosition();
    return [x, y];
  },
  setPosition: (x, y) => liveTrackerWindow()?.setPosition(x, y),
  settingsSet,
});

/** Send to both renderer windows; a closed or destroyed window is skipped. */
function broadcast(channel: string, payload?: unknown): void {
  for (const win of [mainWindow, trackerWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

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

function createMainWindow(tracking: TrackingService) {
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
  // is closed; persist bounds so the next launch reopens in the same spot
  // (normal bounds even when closing maximized). The overlay is still open
  // here ('closed' closes it), so its position is saved as a safety net for a
  // drag whose end never reached main.
  mainWindow.on('close', () => {
    if (mainWindow) {
      const b = mainWindow.getNormalBounds();
      settingsSet('main_window_x',         String(b.x));
      settingsSet('main_window_y',         String(b.y));
      settingsSet('main_window_width',     String(b.width));
      settingsSet('main_window_height',    String(b.height));
      settingsSet('main_window_maximized', mainWindow.isMaximized() ? 'true' : 'false');
    }
    overlayPosition.persist();
    tracking.shutdown();
  });

  // Windows shutdown / restart / log-off: app 'before-quit' / 'will-quit' /
  // 'quit' are NOT emitted then, and the window's 'close' isn't documented to
  // be — this is the one hook. It can't be prevented, so the synchronous
  // (better-sqlite3) final write happens inside the listener.
  mainWindow.on('session-end', () => {
    overlayPosition.persist();
    tracking.shutdown();
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
  // Same monitor-gone fallback as the main window: a saved overlay position on
  // a disconnected display reverts to the default corner.
  const saved = readSavedOverlayPosition(settingsGetAll(), (x, y) => boundsVisibleOnSomeDisplay(x, y, 360, 200));

  trackerWindow = new BrowserWindow({
    width:     360,
    height:    200,
    minWidth:  TRACKER_MIN_WIDTH,
    minHeight: TRACKER_MIN_HEIGHT,
    x: saved?.x ?? TRACKER_DEFAULT_X,
    y: saved?.y ?? TRACKER_DEFAULT_Y,
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
    const count = itemsImportBatch(items).length;
    log.info('database', `Auto-seeded ${count} items from full_table.json`);
  } catch (err) {
    log.error('database', `Failed to seed items: ${err}`);
  }
}

/** Open the app database and bring its schema up to date. */
function openDatabase(): SqlConn {
  const userData = app.getPath('userData');
  const dbPath   = join(userData, 'tli-tracker.db');
  const conn     = openBetterSqlite3(dbPath);
  const result   = initDb(conn, {backup: reason => backupDb(conn, userData, reason)});
  log.info('database', `Database initialized at ${dbPath}`);
  // Warn and continue (user decision). No window exists yet, so the box is parentless.
  const message = newerSchemaMessage(result);
  if (message) dialog.showMessageBoxSync({type: 'warning', title: 'TLI Tracker', message, buttons: ['Continue']});
  return conn;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  log.info('app', 'App starting');

  const sessions = new SqliteSessionStore(openDatabase());
  seedItemsIfEmpty();
  initLogger({logFile: join(app.getPath('userData'), LOG_FILENAME), settings: settingsGetAll});
  // After the logger (so its lines reach the file), before any tracking:
  // sessions left open by a run that never reached Stop.
  closeCrashedSessions(sessions, log);
  initLeaguesAndPriceHistory(broadcast);

  const wealthSeries = new WealthSeries({
    points:   {heads: wealthGetRangeHeads, range: wealthGetRange, latest: wealthGetLatest},
    items:    {getAll: itemsGetAll},
    filters:  {getAll: filtersGetAll},
    settings: {getAll: settingsGetAll},
    log,
  });
  const tracking = new TrackingService({
    createEngine,
    store:          sessions,
    broadcast,
    createWorker:   onEvent => new WorkerProcess(onEvent),
    settings:       {getAll: settingsGetAll},
    filters:        {getAll: filtersGetAll},
    items: {
      getAll:             itemsGetAll,
      getLocked:          itemsGetLocked,
      insertIfMissing:    itemsInsertIfMissing,
      recordScrapedPrice: (id, price, listings, opts) => priceRecord(id, 'scrape', price, listings, opts),
    },
    wealthRecorder: new WealthRecorder({items: {getAll: itemsGetAll}, insert: wealthInsert, log}),
    wealthSeries,
    log,
  });

  registerDbHandlers({
    broadcast,
    onItemTypeChanged: (id, type) => tracking.setItemType(id, type),
    sessions,
    tracking,
    wealthSeries,
  });
  registerOverlayHandlers(
    () => trackerWindow,
    (w) => { trackerWindow = w; },
    createTrackerWindow,
    overlayPosition,
  );
  registerEngineHandlers(tracking);
  registerSettingsHandlers(new SettingsService({
    store: {set: settingsSet, getAll: settingsGetAll},
    broadcast,
    tracking,
    log,
  }));
  tracking.startWorker(); // tail the game log now if the torchlight path is already set
  registerUpdaterHandlers(() => mainWindow);
  registerLoggingHandlers();

  log.debug('app', 'IPC handlers registered');

  // A quit that doesn't start by closing the main window (app.quit() from
  // elsewhere, autoUpdater.quitAndInstall). shutdown() is idempotent, so the
  // usual close → window-all-closed → quit path makes this a no-op.
  app.on('before-quit', () => tracking.shutdown());

  createMainWindow(tracking);
});

app.on('window-all-closed', () => {
  log.info('app', 'App quitting');
  app.quit();
});
