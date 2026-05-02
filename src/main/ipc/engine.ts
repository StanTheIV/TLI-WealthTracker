import {ipcMain, BrowserWindow} from 'electron';
import {log} from '@/main/logger';
import {itemsGetAll, itemsSetPrice, itemsInsertIfMissing, sessionsGetOne, filtersGetAll, settingsGetAll} from '@/main/db';
import {broadcastItemsChanged} from '@/main/items-broadcast';
import {SessionPersistence} from '@/main/session-persistence';
import {WorkerProcess} from '@/main/worker-process';
import {WealthRecorder} from '@/main/wealth-recorder';
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
import {SandlordHandler} from '@/main/engine/handlers/sandlord-handler';
import {ItemHandler} from '@/main/engine/handlers/item';
import {MapMaterialHandler} from '@/main/engine/handlers/map-material';
import {ErrorHandler} from '@/main/engine/handlers/error';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEvent} from '@/types/electron';

const LOG_SUBPATH = 'TorchLight/Saved/Logs/UE_game.log';

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
    log.info('price', `Price update: item=${raw.itemId} -> ${raw.price} FE`);
    itemsSetPrice(String(raw.itemId), raw.price);

    // Sync renderer itemsStores via the unified items:changed broadcast.
    broadcastItemsChanged({id: String(raw.itemId), changes: {price: raw.price}});

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

    if (event.type === 'init_complete' || event.type === 'map_ended') {
      wealthRecorder.snapshot();
      const recorded: EngineEvent = {type: 'wealth_recorded', timestamp: Date.now()};
      broadcastToRenderers('engine:event', recorded);
    }
  };

  // Prices are handled directly in onWorkerMessage so they work even without a
  // running engine (between-session price scrapes happen in town).
  return new Engine(emit)
    .register(new BagInitHandler())
    .register(new SandlordHandler())  // before ZoneHandler — answers suppressMapTracker()
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
    ensureWorker(logPath);
  }
}
