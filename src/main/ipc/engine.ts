import {ipcMain, BrowserWindow} from 'electron';
import {log} from '@/main/logger';
import {itemsGetAll, itemsSetPrice, itemsGetLocked, itemsInsertIfMissing, sessionsGetOne, filtersGetAll, settingsGetAll} from '@/main/db';
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
import {LunariaHandler} from '@/main/engine/handlers/lunaria-handler';
import {ArcanaHandler} from '@/main/engine/handlers/arcana-handler';
import {SandlordHandler} from '@/main/engine/handlers/sandlord-handler';
import {SandlordMapHandler} from '@/main/engine/handlers/sandlord-map-handler';
import {HuntingHandler} from '@/main/engine/handlers/hunting-handler';
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
    const id = String(raw.itemId);
    if (itemsGetLocked(id)) {
      log.debug('price', `Price update skipped (locked): item=${id} -> ${raw.price} FE`);
      return;
    }
    log.info('price', `Price update: item=${id} -> ${raw.price} FE`);
    itemsSetPrice(id, raw.price);

    // Sync renderer itemsStores via the unified items:changed broadcast.
    broadcastItemsChanged({id, changes: {price: raw.price}});

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
  return new Engine(emit)
    .register(new BagInitHandler())
    .register(new SandlordHandler())  // before ZoneHandler — sets ctx.seasonal.ownsBubble
    .register(new ZoneHandler())
    .register(new DreamHandler())
    .register(new VorexHandler())
    .register(new OverrealmHandler())
    .register(new CarjackHandler())
    .register(new ClockworkHandler())
    .register(new LunariaHandler())
    .register(new ArcanaHandler())
    .register(new SandlordMapHandler())
    .register(new HuntingHandler())
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

  // Restore persisted engine settings.
  const settings = settingsGetAll();
  engine.setLowStockThreshold(parsePositiveInt(settings['lowStockThreshold'], 0, /*allowZero*/ true));

  // Per-handler loot collection windows (ms). Default 5000, except the Sandlord
  // in-map wave window (10000) — it measures wave activity, not loot pickup.
  const overrealmMs    = parsePositiveInt(settings['overrealmLootMs'], 5000, /*allowZero*/ false);
  const carjackMs      = parsePositiveInt(settings['carjackLootMs'],   5000, /*allowZero*/ false);
  const clockworkMs    = parsePositiveInt(settings['clockworkLootMs'], 5000, /*allowZero*/ false);
  const lunariaMs      = parsePositiveInt(settings['lunariaLootMs'],   5000, /*allowZero*/ false);
  const sandlordWaveMs = parsePositiveInt(settings['sandlordWaveMs'], 10000, /*allowZero*/ false);
  const huntingMs      = parsePositiveInt(settings['huntingLootMs'],   5000, /*allowZero*/ false);
  engine.setOverrealmLootDurationMs(overrealmMs);
  engine.setCarjackLootDurationMs(carjackMs);
  engine.setClockworkLootDurationMs(clockworkMs);
  engine.setLunariaLootDurationMs(lunariaMs);
  engine.setSandlordWaveDurationMs(sandlordWaveMs);
  engine.setHuntingLootDurationMs(huntingMs);

  log.info('engine', 'Engine started');
}

function parsePositiveInt(raw: string | undefined, fallback: number, allowZero: boolean): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (allowZero ? n < 0 : n <= 0) return fallback;
  return Math.floor(n);
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
