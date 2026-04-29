import {ipcMain, BrowserWindow, utilityProcess} from 'electron';
import type {UtilityProcess} from 'electron';
import {log} from '@/main/logger';
import {itemsGetAll, itemsSetPrice, itemsInsertIfMissing, wealthInsert, sessionsInsert, sessionsUpdate, sessionsGetOne, filtersGetAll, settingsGetAll, sessionMapsInsert} from '@/main/db';
import {broadcastItemsChanged} from '@/main/items-broadcast';
import type {DbSession, DbSessionMap} from '@/main/db';
import {ItemFilterEngine} from '@/main/engine/item-filter';
import type {FilterRule} from '@/types/itemFilter';
import {mapRawType} from '@/types/itemType';
import {Engine} from '@/main/engine/engine';
import {BagInitHandler} from '@/main/engine/handlers/bag-init';
import {ZoneHandler} from '@/main/engine/handlers/zone';
import {DreamHandler} from '@/main/engine/handlers/dream-handler';
import {VorexHandler} from '@/main/engine/handlers/vorex-handler';
import {OverrealmHandler} from '@/main/engine/handlers/overrealm-handler';
import {CarjackHandler} from '@/main/engine/handlers/carjack-handler';
import {ClockworkHandler} from '@/main/engine/handlers/clockwork-handler';
import {ItemHandler} from '@/main/engine/handlers/item';
import {MapMaterialHandler} from '@/main/engine/handlers/map-material';
import {ErrorHandler} from '@/main/engine/handlers/error';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEvent} from '@/types/electron';

const LOG_SUBPATH = 'TorchLight/Saved/Logs/UE_game.log';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let logReaderProcess: UtilityProcess | null = null;
let engine: Engine | null = null;

// Window accessors — set once in registerEngineHandlers
let _getMainWindow:    () => BrowserWindow | null = () => null;
let _getTrackerWindow: () => BrowserWindow | null = () => null;

/** Tracks the identity of the current session for auto-save on stop. */
interface ActiveSessionState {
  /** UUID for this run — either a new random ID or the ID of the loaded session. */
  sessionId:    string;
  /** Name of a loaded (continued) session. Null for new sessions. */
  sessionName:  string | null;
  /** True when this run is continuing a previously saved session. */
  isOverride:   boolean;
}

let activeSession: ActiveSessionState | null = null;

/**
 * Buffer of per-map rows for the active session. Filled on every map exit
 * (tracker_finished kind=map) and flushed to disk in autoSaveSession when
 * the run actually persists. Cleared on engine reset / stop / save.
 *
 * We buffer rather than write-through so that a discarded short run (below
 * MIN_SAVE_DURATION_MS, no drops) doesn't leave orphan map rows behind.
 */
let pendingMapRows: DbSessionMap[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSessionName(): string {
  const now   = new Date();
  const month = now.toLocaleString('en', {month: 'short'});
  const day   = now.getDate();
  const year  = now.getFullYear();
  const time  = now.toLocaleTimeString('en', {hour: '2-digit', minute: '2-digit', hour12: false});
  return `Session - ${month} ${day}, ${year} ${time}`;
}

/** Minimum total session duration (ms) before auto-saving. */
const MIN_SAVE_DURATION_MS = 30_000;

/**
 * Persists the just-finished session to the DB.
 * Called synchronously from the emit callback (Node.js single-threaded — safe).
 * Returns the saved session ID, or null if nothing was saved.
 */
function autoSaveSession(
  event: Extract<EngineEvent, {type: 'tracker_finished'}>,
  session: ActiveSessionState,
): string | null {
  const {tracker, sessionMeta} = event;
  if (!sessionMeta) return null;

  const {elapsed: totalTimeMs} = tracker;
  const {mapTime: mapTimeMs, mapCount} = sessionMeta;

  const hasDrops = Object.keys(tracker.drops).length > 0;
  const hasTime  = totalTimeMs >= MIN_SAVE_DURATION_MS;
  if (!hasDrops && !hasTime) return null;

  const drops: Record<string, number> = {};
  for (const [k, v] of Object.entries(tracker.drops)) drops[String(k)] = v;

  const now = new Date().toISOString();

  const record: DbSession = {
    id:        session.sessionId,
    name:      session.sessionName ?? generateSessionName(),
    savedAt:   now,
    totalTime: totalTimeMs / 1000, // ms → seconds
    mapTime:   mapTimeMs  / 1000,
    mapCount,
    drops,
  };

  if (session.isOverride) {
    sessionsUpdate(record);
  } else {
    sessionsInsert(record);
  }

  // Flush any per-map rows accumulated during this run alongside the session.
  if (pendingMapRows.length > 0) {
    sessionMapsInsert(pendingMapRows);
    log.debug('database', `Saved ${pendingMapRows.length} per-map rows for session ${session.sessionId}`);
    pendingMapRows = [];
  }

  log.info('session', `Session saved: id=${record.id}`);
  return record.id;
}

// ---------------------------------------------------------------------------
// Wealth recording
// ---------------------------------------------------------------------------

function recordWealth(): void {
  if (!engine) return;
  const inventory = engine.getInventory();
  const itemMap   = new Map(itemsGetAll().map(i => [i.id, i]));
  const filter    = engine.getFilter();

  const breakdown: Record<string, {qty: number; price: number; total: number}> = {};
  let totalValue = 0;

  for (const [itemId, qty] of inventory) {
    if (qty <= 0) continue;
    if (filter && !filter.shouldInclude(itemId, 'wealth')) continue;
    const item  = itemMap.get(String(itemId));
    const price = item?.price ?? 0;
    const itemTotal = qty * price;
    breakdown[String(itemId)] = {qty, price, total: itemTotal};
    totalValue += itemTotal;
  }

  wealthInsert({
    timestamp: Date.now(),
    value:     totalValue,
    sessionId: activeSession?.sessionId ?? null,
    breakdown: JSON.stringify(breakdown),
  });

  log.debug('wealth', `Wealth snapshot: value=${totalValue}, items=${Object.keys(breakdown).length}`);
}

// ---------------------------------------------------------------------------
// Log reader (worker) — runs independently of the engine
// ---------------------------------------------------------------------------

/**
 * Handles a raw event from the worker process.
 * Price events are always processed (even without an active engine).
 * All other events are forwarded to the engine if it exists.
 */
function onWorkerMessage(raw: RawEvent): void {
  if (raw.type === 'worker_log') {
    log[raw.logType]('worker', raw.message);
    return;
  }

  if (raw.type === 'reader_ready') {
    log.debug('worker', 'Reader ready');
    return;
  }

  if (raw.type === 'reader_error') {
    log.error('worker', `Reader error: ${raw.message}`);
    return;
  }

  if (raw.type === 'price_update') {
    log.info('price', `Price update: item=${raw.itemId} -> ${raw.price} FE`);
    itemsSetPrice(String(raw.itemId), raw.price);

    // Sync renderer itemsStores via the unified items:changed broadcast.
    broadcastItemsChanged({id: String(raw.itemId), changes: {price: raw.price}});

    // Also emit the engine event so any other engine-event consumers (e.g. a
    // future "price updated" feed entry) keep working. The itemsStore no
    // longer reacts to this — items:changed is the source of truth.
    const event: EngineEvent = {type: 'price_update', itemId: raw.itemId, price: raw.price, timestamp: Date.now()};
    _getMainWindow()?.webContents.send('engine:event', event);
    _getTrackerWindow()?.webContents.send('engine:event', event);
    return;
  }

  // All other events go to the engine (if running)
  engine?.onRawEvent(raw);
}

function startWorker(logPath: string): void {
  if (logReaderProcess) return; // already running

  const {join} = require('path') as typeof import('path');
  logReaderProcess = utilityProcess.fork(join(__dirname, 'index.js'));

  logReaderProcess.on('message', onWorkerMessage);
  logReaderProcess.on('exit', () => {
    log.warn('worker', 'Worker exited');
    logReaderProcess = null;
  });

  logReaderProcess.postMessage({type: 'start', logPath});
  log.info('worker', `Worker started, tailing: ${logPath}`);
}

function stopWorker(): void {
  if (logReaderProcess) {
    log.info('worker', 'Worker stopped');
    logReaderProcess.kill();
    logReaderProcess = null;
  }
}

/** Resolves the game log path from the torchlight path stored in settings. */
function resolveLogPath(): string | null {
  const torchlightPath = settingsGetAll()['torchlightPath'];
  if (!torchlightPath) return null;
  return `${torchlightPath}/${LOG_SUBPATH}`;
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

function createEngine(): Engine {
  const emit = (event: EngineEvent) => {
    // Persist a placeholder row for newly discovered items so the renderer's
    // items store (and all subsequent sessions) pick them up immediately.
    if (event.type === 'new_item') {
      const id = String(event.itemId);
      const inserted = itemsInsertIfMissing(id);
      if (inserted) log.info('database', `New item discovered: id=${id}`);
    }

    // Buffer a per-map row on every map exit. Flushed to disk inside
    // autoSaveSession; cleared if the run is discarded.
    if (event.type === 'tracker_finished' && event.tracker.kind === 'map' && activeSession) {
      const drops: Record<string, number> = {};
      for (const [k, v] of Object.entries(event.tracker.drops)) drops[String(k)] = v;
      const spent = engine?.getLastMapSpends() ?? {};
      pendingMapRows.push({
        sessionId: activeSession.sessionId,
        mapIndex:  pendingMapRows.length + 1,
        startedAt: event.timestamp - event.tracker.elapsed,
        duration:  event.tracker.elapsed,
        drops,
        spent,
      });
    }

    // Auto-save session on stop, then notify renderer so it can refresh
    if (event.type === 'tracker_finished' && event.tracker.kind === 'session' && activeSession) {
      const savedId = autoSaveSession(event, activeSession);
      if (savedId) {
        log.info('engine', `Session auto-saved: id=${savedId}`);
        const savedEvent: EngineEvent = {type: 'session_saved', sessionId: savedId};
        _getMainWindow()?.webContents.send('engine:event', savedEvent);
        _getTrackerWindow()?.webContents.send('engine:event', savedEvent);
      }
      // Whatever path autoSaveSession took (saved or skipped), the buffer
      // is no longer needed once the session ends.
      pendingMapRows = [];
    }

    _getMainWindow()?.webContents.send('engine:event', event);
    _getTrackerWindow()?.webContents.send('engine:event', event);

    if (event.type === 'init_complete' || event.type === 'map_ended') {
      recordWealth();
      const recorded: EngineEvent = {type: 'wealth_recorded', timestamp: Date.now()};
      _getMainWindow()?.webContents.send('engine:event', recorded);
      _getTrackerWindow()?.webContents.send('engine:event', recorded);
    }
  };

  // Prices are handled directly in onWorkerMessage so they work even without a
  // running engine (between-session price scrapes happen in town).
  return new Engine(emit)
    .register(new BagInitHandler())
    .register(new ZoneHandler())
    .register(new DreamHandler())
    .register(new VorexHandler())
    .register(new OverrealmHandler())
    .register(new CarjackHandler())
    .register(new ClockworkHandler())
    .register(new ItemHandler())
    .register(new MapMaterialHandler())
    .register(new ErrorHandler());
}

function startEngine(logPath: string, loadSessionId?: string): void {
  stopEngine();

  // Ensure worker is running (idempotent — won't restart if already up)
  startWorker(logPath);

  engine = createEngine();

  if (loadSessionId) {
    const loaded = sessionsGetOne(loadSessionId);
    if (loaded) {
      activeSession = {
        sessionId:   loaded.id,
        sessionName: loaded.name,
        isOverride:  true,
      };
      log.info('session', `Session loaded: id=${loaded.id}, name="${loaded.name}"`);
      engine.loadSession({
        id:        loaded.id,
        name:      loaded.name,
        drops:     loaded.drops,
        totalTime: loaded.totalTime, // seconds — engine converts to ms
        mapTime:   loaded.mapTime,
        mapCount:  loaded.mapCount,
      });
    } else {
      activeSession = {sessionId: crypto.randomUUID(), sessionName: null, isOverride: false};
      log.info('session', `Session created: id=${activeSession.sessionId}`);
    }
  } else {
    activeSession = {sessionId: crypto.randomUUID(), sessionName: null, isOverride: false};
    log.info('session', `Session created: id=${activeSession.sessionId}`);
  }

  engine.start();

  // Everything below must run AFTER start() — ctx.reset() wipes context state,
  // including the filter and the known-item set.
  const allItems = itemsGetAll();
  engine.setKnownItems(allItems.map(i => i.id));

  const itemTypeMap = new Map(allItems.map(i => [i.id, mapRawType(i.type)]));
  const activeFilter = filtersGetAll().find(f => f.enabled);
  if (activeFilter) {
    const rules = JSON.parse(activeFilter.rules) as FilterRule[];
    engine.setFilter(new ItemFilterEngine(rules, itemTypeMap));
    log.info('filter', `Filter set: "${activeFilter.name}" (${rules.length} rules)`);
  }

  // Restore the user's low-stock threshold (defaults to 0).
  const rawThreshold = settingsGetAll()['lowStockThreshold'];
  const parsedThreshold = rawThreshold !== undefined ? Number(rawThreshold) : 0;
  const threshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0
    ? Math.floor(parsedThreshold)
    : 0;
  engine.setLowStockThreshold(threshold);

  log.info('engine', 'Engine started');
}

function stopEngine(): void {
  if (engine) {
    log.info('engine', 'Engine stopped');
    engine.stop();
    engine = null;
  }
  activeSession = null;
  // Defensive: if any buffered map rows survived (e.g. engine.stop() didn't
  // emit tracker_finished for some reason), drop them now so they can't
  // contaminate the next session.
  pendingMapRows = [];
  // Worker keeps running — it's independent
}

/**
 * Called when the user changes an item's type (via the Items tab UI). Updates
 * the engine's filter type-cache so the next drop event uses the new type.
 * No-op when the engine isn't running.
 */
export function notifyEngineItemTypeChanged(id: string, type: string): void {
  engine?.setItemType(id, mapRawType(type));
}

/** Called by main.ts on window close to ensure the session is auto-saved before quit. */
export function stopEngineForShutdown(): void {
  stopEngine();
  stopWorker();
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function registerEngineHandlers(
  getMainWindow:   () => BrowserWindow | null,
  getTrackerWindow:() => BrowserWindow | null,
): void {
  _getMainWindow    = getMainWindow;
  _getTrackerWindow = getTrackerWindow;

  ipcMain.on('engine:start',              (_e, logPath: string)                      => startEngine(logPath));
  ipcMain.on('engine:start-with-session', (_e, logPath: string, sessionId: string)   => startEngine(logPath, sessionId));
  ipcMain.on('engine:stop',   ()  => stopEngine());
  ipcMain.on('engine:pause',  ()  => { engine?.pause();  log.info('engine', 'Engine paused'); });
  ipcMain.on('engine:resume', ()  => { engine?.resume(); log.info('engine', 'Engine resumed'); });
  ipcMain.on('engine:reset',  ()  => {
    if (!engine) return;
    engine.reset();
    // The discarded run's identity must not be reused by the next Stop, and
    // any buffered per-map rows belong to the discarded run — drop them.
    pendingMapRows = [];
    activeSession = {sessionId: crypto.randomUUID(), sessionName: null, isOverride: false};
    log.info('session', `Session reset; new id=${activeSession.sessionId}`);
  });
  // Note: item type changes are now propagated via `db:items:set-type`,
  // which the db handler registration wires up to call
  // notifyEngineItemTypeChanged() so the engine's filter cache stays current.
  ipcMain.on('engine:dismiss-material', (_e, itemId: number) => {
    engine?.dismissMaterial(itemId);
  });
  ipcMain.on('engine:set-low-stock-threshold', (_e, n: number) => {
    engine?.setLowStockThreshold(n);
  });
  ipcMain.on('engine:update-filter-rules', (_e, payload: FilterRule[] | null) => {
    if (!engine) return;
    if (payload === null) {
      engine.updateFilterRules(null);
      log.debug('filter', 'Filter cleared');
    } else {
      const allItems  = itemsGetAll();
      const typeMap   = new Map(allItems.map(i => [i.id, mapRawType(i.type)]));
      if (!engine.getFilter()) {
        engine.setFilter(new ItemFilterEngine(payload, typeMap));
      } else {
        engine.updateFilterRules(payload);
      }
      log.debug('filter', `Filter rules updated: ${payload.length} rules`);
    }
  });

  log.debug('ipc', 'Engine handlers registered');

  // Start the worker immediately if we already have a valid torchlight path
  const logPath = resolveLogPath();
  if (logPath) {
    startWorker(logPath);
  }
}
