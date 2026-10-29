import {app, BrowserWindow, ipcMain, dialog, Menu, screen, type WebContents} from 'electron';
import {join} from 'path';
import {existsSync, readFileSync} from 'fs';
import {
  adoptDb, migrateDb, itemsCount, itemsImportBatch, itemsGetAll, itemsGetLocked, itemsInsertIfMissing, priceRecord,
  filtersGetAll, settingsGetAll, settingsSet, wealthInsert, wealthGetRange, wealthGetRangeHeads, wealthGetLatest,
} from './db';
import {backupDb} from './db/backup';
import {openBetterSqlite3} from './db/drivers/better-sqlite3';
import {newerSchemaMessage} from './db/schema-newer';
import {SqliteSessionStore} from './db/session-store';
import type {SqlConn} from './db/sql-conn';
import {getLogFilePath, initLogger, log} from './logger';
import type {DbItem} from '@/shared/contracts/db';
import {describeError, describeErrorBrief} from '@/shared/describe-error';
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
import {runShutdownSteps, type ShutdownStep} from './shutdown';
import {ERROR_BOX_TITLE, errorBoxContent, installProcessErrorHandlers} from './process-errors';
import {createCrashBudget, type CrashBudget} from './crash-budget';
import {createEngine} from './engine/create-engine';
import {WorkerProcess} from './worker-process';
import {WealthRecorder} from './wealth-recorder';
import {WealthSeries} from './wealth-series';
import {OverlayPosition, readSavedOverlayPosition} from './overlay-position';
import {lockDownWebContents} from './window-guards';
import {LOG_FILENAME, LOG_SUBPATH} from '@/shared/paths';

// First, before anything can fail: until initLogger() runs, `log` writes to
// the console only and the error box names no log file.
installProcessErrorHandlers({
  on:           (event, listener) => { process.on(event, listener); },
  log,
  showErrorBox: (title, content) => dialog.showErrorBox(title, content),
  logPath:      getLogFilePath,
});

const DEV = !app.isPackaged;
const VITE_DEV_SERVER = 'http://localhost:5173';

// A second launch quits here and runs nothing else; the running app focuses its window ('second-instance').
const PRIMARY_INSTANCE = app.requestSingleInstanceLock();
if (!PRIMARY_INSTANCE) app.quit();

// Dev-only: expose Chrome DevTools Protocol so tooling (e.g. the Electron MCP
// server) can attach to inspect the DOM, run renderer JS, and take screenshots.
// Gated to DEV so a debugging port never ships in packaged builds.
if (DEV && PRIMARY_INSTANCE) {
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
// Renderer crashes and load failures (both windows)
// ---------------------------------------------------------------------------

// One budget per window, kept across overlay re-creations.
const mainCrashBudget    = createCrashBudget({max: 3, windowMs: 60_000, now: () => Date.now()});
const overlayCrashBudget = createCrashBudget({max: 3, windowMs: 60_000, now: () => Date.now()});

/** A crashed renderer reloads its window (all state lives in main; the page
 *  catches up on load). Over budget: an error box; the main window stays dead,
 *  the overlay is destroyed ('closed' nulls it) so the next show recreates it. */
function reloadOnCrash(win: BrowserWindow, name: string, budget: CrashBudget, onGiveUp?: () => void): void {
  win.webContents.on('render-process-gone', (_event, {reason, exitCode}) => {
    const what    = `${name} renderer gone (${reason}, exit code ${exitCode})`;
    const verdict = budget.onGone(reason);
    if (verdict === 'ignore') {
      log.info('app', what);
    } else if (verdict === 'reload') {
      log.warn('app', `${what} — reloading`);
      if (!win.isDestroyed()) win.webContents.reload();
    } else {
      log.error('app', `${what} — crashed too often, not reloading`);
      dialog.showErrorBox(ERROR_BOX_TITLE, errorBoxContent(
        `The ${name} keeps crashing and was not reloaded. Please restart TLI Tracker.`, getLogFilePath()));
      onGiveUp?.();
    }
  });
}

/** A `logging:report` sender's name for the log line and the per-window rate limit. */
function rendererWindowName(sender: WebContents): string {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === sender.id) return 'main window';
  if (liveTrackerWindow()?.webContents.id === sender.id) return 'overlay';
  return 'unknown window';
}

/** The page load's rejection (dev server down, missing bundle) — logged; the window stays blank. */
function logLoadFailure(name: string, load: Promise<void>): void {
  load.catch((err: unknown) => log.error('app', `${name} failed to load: ${describeError(err)}`));
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

/** Save the main window's normal (un-maximized) bounds and maximized flag. */
function persistMainBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const b = win.getNormalBounds();
  settingsSet('main_window_x',         String(b.x));
  settingsSet('main_window_y',         String(b.y));
  settingsSet('main_window_width',     String(b.width));
  settingsSet('main_window_height',    String(b.height));
  settingsSet('main_window_maximized', win.isMaximized() ? 'true' : 'false');
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

  lockDownWebContents(mainWindow.webContents, 'main window', log);
  reloadOnCrash(mainWindow, 'main window', mainCrashBudget);
  logLoadFailure('Main window', DEV
    ? mainWindow.loadURL(VITE_DEV_SERVER)
    : mainWindow.loadFile(join(__dirname, '../dist/index.html')));

  // Stop the engine before the window is destroyed so any active session is
  // closed — first, each step isolated, so a failing settings write can't skip
  // it. Then the bounds, for the next launch to reopen in the same spot, and
  // the overlay's position: still open here ('closed' closes it), saved as a
  // safety net for a drag whose end never reached main.
  const win = mainWindow;
  const shutdownSteps: ShutdownStep[] = [
    {name: 'tracking',           run: () => tracking.shutdown()},
    {name: 'main window bounds', run: () => persistMainBounds(win)},
    {name: 'overlay position',   run: () => overlayPosition.persist()},
  ];
  mainWindow.on('close', () => runShutdownSteps(shutdownSteps, log));

  // Windows shutdown / restart / log-off: app 'before-quit' / 'will-quit' /
  // 'quit' are NOT emitted then, and the window's 'close' isn't documented to
  // be — this is the one hook. It can't be prevented, so the synchronous
  // (better-sqlite3) final write happens inside the listener.
  mainWindow.on('session-end', () => runShutdownSteps(shutdownSteps, log));

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

  const overlay = trackerWindow;
  lockDownWebContents(overlay.webContents, 'overlay', log);
  reloadOnCrash(overlay, 'overlay', overlayCrashBudget, () => { if (!overlay.isDestroyed()) overlay.destroy(); });
  logLoadFailure('Overlay', DEV
    ? trackerWindow.loadURL(`${VITE_DEV_SERVER}?window=overlay`)
    : trackerWindow.loadFile(join(__dirname, '../dist/index.html'), {query: {window: 'overlay'}}));

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
    log.error('database', `Failed to seed items: ${describeError(err)}`);
  }
}

/**
 * Open the app database (the logger is already up, on its defaults: a failed
 * open is logged to file). Once adopted, the stored logging config applies to
 * the migrations' lines (a fresh DB has no settings table yet — defaults);
 * after them it is read again.
 */
function openDatabase(userData: string): SqlConn {
  const dbPath = join(userData, 'tli-tracker.db');
  const conn   = openBetterSqlite3(dbPath);
  adoptDb(conn);
  log.reloadConfig();
  const result = migrateDb({backup: reason => backupDb(conn, userData, reason)});
  log.reloadConfig();
  log.info('database', `Database initialized at ${dbPath}`);
  // Warn and continue (user decision). No window exists yet, so the box is parentless.
  const message = newerSchemaMessage(result);
  if (message) dialog.showMessageBoxSync({type: 'warning', title: 'TLI Tracker', message, buttons: ['Continue']});
  return conn;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/** Everything from ready to the main window. Any throw is fatal (failStartup). */
function startApp(): void {
  // Before the DB: its reader throws until a connection is adopted, so the
  // logger starts on its defaults (file on for warn + error) and a failed
  // open reaches the log file — and failStartup's box can name it.
  const userData = app.getPath('userData');
  initLogger({logFile: join(userData, LOG_FILENAME), settings: settingsGetAll});

  Menu.setApplicationMenu(null);
  log.info('app', 'App starting');

  const sessions = new SqliteSessionStore(openDatabase(userData));
  seedItemsIfEmpty();
  // Before any tracking: sessions left open by a run that never reached Stop.
  closeCrashedSessions(sessions, log);
  initLeaguesAndPriceHistory(broadcast);

  const wealthSeries = new WealthSeries({
    points:   {heads: wealthGetRangeHeads, range: wealthGetRange, latest: wealthGetLatest},
    items:    {getAll: itemsGetAll},
    filters:  {getAll: filtersGetAll},
    settings: {getAll: settingsGetAll},
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
    onFiltersChanged:  () => tracking.applyActiveFilter(),
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
  registerUpdaterHandlers(() => mainWindow);
  registerLoggingHandlers({windowName: rendererWindowName});

  log.debug('app', 'IPC handlers registered');

  // Tail the game log now if the torchlight path is already set. Not fatal:
  // the next Start starts the worker again.
  try {
    tracking.startWorker();
  } catch (err) {
    log.error('worker', `Log reader start failed: ${describeError(err)}`);
  }

  // A quit that doesn't start by closing the main window (app.quit() from
  // elsewhere, autoUpdater.quitAndInstall). shutdown() is idempotent, so the
  // usual close → window-all-closed → quit path makes this a no-op.
  app.on('before-quit', () => tracking.shutdown());

  createMainWindow(tracking);
}

/** A startup failure (DB open or migration, …) leaves no usable app: log,
 *  say why, exit — app.exit skips before-quit / will-quit. */
function failStartup(err: unknown): void {
  log.error('app', `Startup failed: ${describeError(err)}`);
  try {
    dialog.showErrorBox('TLI Tracker failed to start', errorBoxContent(describeErrorBrief(err), getLogFilePath()));
  } catch { /* exit regardless */ }
  app.exit(1);
}

if (PRIMARY_INSTANCE) {
  // Emitted after ready; no main window yet (startup) or anymore (quitting) → nothing to focus.
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    try {
      startApp();
    } catch (err) {
      failStartup(err);
    }
  });

  app.on('window-all-closed', () => {
    log.info('app', 'App quitting');
    app.quit();
  });
}
