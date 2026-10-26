import {ipcMain, BrowserWindow} from 'electron';
import {log} from '@/main/logger';
import {itemsGetAll, priceRecord, itemsGetLocked, itemsInsertIfMissing, sessionsGetOne, filtersGetAll, settingsGetAll} from '@/main/db';
import {broadcastItemsChanged} from '@/main/items-broadcast';
import {SessionPersistence} from '@/main/session-persistence';
import {WorkerProcess} from '@/main/worker-process';
import {WealthRecorder} from '@/main/wealth-recorder';
import {configureEngine} from '@/main/engine/configure-engine';
import type {FilterRule} from '@/shared/item-filter';
import {mapRawType} from '@/shared/items';
import type {Engine} from '@/main/engine/engine';
import {createEngine as createEngineChain} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEvent} from '@/shared/contracts/engine';
import {LOG_SUBPATH} from '@/shared/paths';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let worker: WorkerProcess | null = null;
let engine: Engine | null = null;
let persistence: SessionPersistence | null = null;

// Window accessors — set once in registerEngineHandlers
let _getMainWindow:    () => BrowserWindow | null = () => null;
let _getTrackerWindow: () => BrowserWindow | null = () => null;

/** Send a payload to both renderer windows (no-ops cleanly when either is closed). */
function broadcastToRenderers(channel: string, payload: unknown): void {
  _getMainWindow()?.webContents.send(channel, payload);
  _getTrackerWindow()?.webContents.send(channel, payload);
}

const wealthRecorder = new WealthRecorder({
  getEngine:    () => engine,
  getSessionId: () => persistence?.getSessionId() ?? null,
});

// ---------------------------------------------------------------------------
// Log reader (worker) — runs independently of the engine
// ---------------------------------------------------------------------------

/**
 * Routes a worker-emitted RawEvent. Price updates are processed even without
 * an active engine (between-session price scrapes happen in town); everything
 * else is forwarded to the engine if it's running.
 */
function onWorkerEvent(raw: RawEvent): void {
  if (raw.type === 'price_update') {
    const id = String(raw.itemId);
    const locked = itemsGetLocked(id);

    // History records every scrape, locked items included: the market showed that
    // price even if the user pinned the item's own value.
    const {priceDate} = priceRecord(id, 'scrape', raw.price, raw.listings, {updateItem: !locked});
    if (locked) {
      log.debug('price', `Price update skipped (locked): item=${id} -> ${raw.price} FE`);
      return;
    }
    log.info('price', `Price update: item=${id} -> ${raw.price} FE`);

    // Sync renderer itemsStores via the unified items:changed broadcast.
    broadcastItemsChanged({id, changes: {price: raw.price, ...(priceDate !== null && {priceDate})}});

    // Also emit the engine event so any other engine-event consumers (e.g. a
    // future "price updated" feed entry) keep working. The itemsStore no
    // longer reacts to this — items:changed is the source of truth.
    const event: EngineEvent = {type: 'price_update', itemId: raw.itemId, price: raw.price, timestamp: Date.now()};
    broadcastToRenderers('engine:event', event);
    return;
  }

  engine?.onRawEvent(raw);
}

function ensureWorker(logPath: string): void {
  if (!worker) worker = new WorkerProcess(onWorkerEvent);
  worker.start(logPath);
}

function stopWorker(): void {
  worker?.stop();
  worker = null;
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

    // Route tracker_finished events through SessionPersistence — it owns the
    // per-map / per-seasonal row buffer and the auto-save logic. Returns an
    // outcome only for kind=session (the auto-save commit point); other kinds
    // produce a null outcome and just buffer internally.
    if (engine && persistence) {
      const outcome = persistence.onTrackerFinished(event, engine);
      if (outcome?.savedId) {
        log.info('engine', `Session auto-saved: id=${outcome.savedId}`);
        const savedEvent: EngineEvent = {type: 'session_saved', sessionId: outcome.savedId};
        broadcastToRenderers('engine:event', savedEvent);
      }
    }

    broadcastToRenderers('engine:event', event);

    // Wealth snapshots: session start, each map end, and the end of a
    // town-started seasonal run (last seasonal finished with no map alive —
    // such runs emit no map_ended, so without this their income wouldn't hit
    // the chart until the next map ends). During a normal map+seasonal town
    // return the map is still alive when seasonals finish, so only map_ended
    // snapshots — no double datapoint.
    const seasonalRunEnded =
      event.type === 'tracker_finished' && event.tracker.kind === 'seasonal'
      && engine !== null && !engine.hasActiveMapTracker() && !engine.hasActiveSeasonals();
    if (event.type === 'init_complete' || event.type === 'map_ended' || seasonalRunEnded) {
      wealthRecorder.snapshot();
      const recorded: EngineEvent = {type: 'wealth_recorded', timestamp: Date.now()};
      broadcastToRenderers('engine:event', recorded);
    }
  };

  // Prices are handled directly in onWorkerMessage so they work even without a
  // running engine (between-session price scrapes happen in town).
  return createEngineChain(emit);
}

function startEngine(logPath: string, loadSessionId?: string): void {
  stopEngine();

  // Ensure worker is running (idempotent — won't restart if already up)
  ensureWorker(logPath);

  engine = createEngine();

  const loaded = loadSessionId ? sessionsGetOne(loadSessionId) : null;
  if (loaded) {
    persistence = new SessionPersistence({sessionId: loaded.id, sessionName: loaded.name, isOverride: true});
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
    persistence = new SessionPersistence({sessionId: crypto.randomUUID(), sessionName: null, isOverride: false});
    log.info('session', `Session created: id=${persistence.getSessionId()}`);
  }

  engine.start();

  const activeFilter = filtersGetAll().find(f => f.enabled);
  configureEngine(engine, {
    items:       itemsGetAll(),
    filterRules: activeFilter ? JSON.parse(activeFilter.rules) as FilterRule[] : null,
    settings:    settingsGetAll(),
  });
  if (activeFilter) log.info('filter', `Filter set: "${activeFilter.name}"`);

  log.info('engine', 'Engine started');
}

function stopEngine(): void {
  if (engine) {
    log.info('engine', 'Engine stopped');
    engine.stop();
    engine = null;
  }
  // Drop the persistence instance — its destructor effectively discards any
  // per-run rows that survived an abnormal stop, since the buffer is private
  // and the instance is unreachable after this point.
  persistence?.discard();
  persistence = null;
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
    // any buffered per-run rows belong to the discarded run — replacing the
    // SessionPersistence instance drops both.
    persistence?.discard();
    persistence = new SessionPersistence({sessionId: crypto.randomUUID(), sessionName: null, isOverride: false});
    log.info('session', `Session reset; new id=${persistence.getSessionId()}`);
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
  ipcMain.on('engine:set-overrealm-loot-ms', (_e, ms: number) => {
    engine?.setOverrealmLootDurationMs(ms);
  });
  ipcMain.on('engine:set-carjack-loot-ms', (_e, ms: number) => {
    engine?.setCarjackLootDurationMs(ms);
  });
  ipcMain.on('engine:set-clockwork-loot-ms', (_e, ms: number) => {
    engine?.setClockworkLootDurationMs(ms);
  });
  ipcMain.on('engine:set-lunaria-loot-ms', (_e, ms: number) => {
    engine?.setLunariaLootDurationMs(ms);
  });
  ipcMain.on('engine:set-sandlord-wave-ms', (_e, ms: number) => {
    engine?.setSandlordWaveDurationMs(ms);
  });
  ipcMain.on('engine:set-hunting-loot-ms', (_e, ms: number) => {
    engine?.setHuntingLootDurationMs(ms);
  });
  ipcMain.on('engine:set-afterlight-loot-ms', (_e, ms: number) => {
    engine?.setAfterlightLootDurationMs(ms);
  });
  ipcMain.on('engine:update-filter-rules', (_e, payload: FilterRule[] | null) => {
    if (!engine) return;
    engine.setFilterRules(payload);
    log.debug('filter', payload === null ? 'Filter cleared' : `Filter rules updated: ${payload.length} rules`);
  });

  log.debug('ipc', 'Engine handlers registered');

  // Start the worker immediately if we already have a valid torchlight path
  const logPath = resolveLogPath();
  if (logPath) {
    ensureWorker(logPath);
  }
}
