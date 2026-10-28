import type {Engine} from '@/main/engine/engine';
import type {EngineSink} from '@/main/engine/types';
import {configureEngine} from '@/main/engine/configure-engine';
import type {SqliteSessionStore} from '@/main/db/session-store';
import type {Logger} from '@/main/logger';
import {SessionPersistence, type SessionMeta} from '@/main/session-persistence';
import type {RawEvent} from '@/worker/processors/types';
import type {DbItem, DbItemFilter, DbSession} from '@/shared/contracts/db';
import type {EngineEvent, SessionIdentity} from '@/shared/contracts/engine';
import type {FilterRule} from '@/shared/item-filter';
import {mapRawType} from '@/shared/items';
import {LOG_SUBPATH} from '@/shared/paths';
import type {Broadcast} from '@/main/broadcast';

/** The log-reader process. `start` is idempotent while running; `stop` is safe when stopped. */
export interface LogWorker {
  start(logPath: string): void;
  stop(): void;
}

export interface TrackingDeps {
  createEngine:   (sink: EngineSink) => Engine;
  store:          SqliteSessionStore;
  broadcast:      Broadcast;
  /** Called once, in the constructor. */
  createWorker:   (onEvent: (raw: RawEvent) => void) => LogWorker;
  /** The raw settings table: `torchlightPath` plus the engine's configuration. */
  settings:       {getAll(): Record<string, string>};
  filters:        {getAll(): DbItemFilter[]};
  items: {
    /** Every known item — engine configuration and the session price reader. */
    getAll(): DbItem[];
    getLocked(id: string): boolean;
    /** True when a placeholder row was inserted. */
    insertIfMissing(id: string): boolean;
    /** Record a scraped price; `priceDate` is null when the item row wasn't updated. */
    recordScrapedPrice(id: string, price: number, listings: number[], opts: {updateItem: boolean}): {priceDate: number | null};
  };
  wealthRecorder: {snapshot(engine: Engine): void};
  log:            Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
}

/** A fresh session's name, in local time. */
function generateSessionName(): string {
  const now   = new Date();
  const month = now.toLocaleString('en', {month: 'short'});
  const day   = now.getDate();
  const year  = now.getFullYear();
  const time  = now.toLocaleTimeString('en', {hour: '2-digit', minute: '2-digit', hour12: false});
  return `Session - ${month} ${day}, ${year} ${time}`;
}

/** A fresh session's identity; the name is taken at start, in local time. */
function newIdentity(): SessionIdentity {
  return {sessionId: crypto.randomUUID(), name: generateSessionName()};
}

/** Emit consumers, named in error logs. */
type EmitConsumer = 'new_item' | 'persistence' | 'broadcast' | 'wealth';

/**
 * Owns one tracking run at a time: the engine, its SessionPersistence, and the
 * log-reader worker that feeds it. Every engine event fans out — in order — to
 * the new-item insert, persistence, the renderer broadcast and the wealth
 * snapshot, each isolated so one failing consumer never starves the others or
 * leaves the engine half-stopped.
 *
 * The worker outlives runs: it tails the game log from registration (or the
 * first start) until shutdown, and price scrapes are routed even with no
 * engine running (between-session scrapes happen in town).
 */
export class TrackingService {
  private readonly _deps:   TrackingDeps;
  private readonly _log:    TrackingDeps['log'];
  private readonly _worker: LogWorker;
  private _engine:      Engine | null             = null;
  private _persistence: SessionPersistence | null = null;
  /** Set by shutdown(), cleared by the next start: a repeated shutdown is a no-op. */
  private _shutDown = false;

  constructor(deps: TrackingDeps) {
    this._deps   = deps;
    this._log    = deps.log;
    this._worker = deps.createWorker(raw => this._onWorkerEvent(raw));
  }

  // -- worker ---------------------------------------------------------------

  /** Start tailing the game log now if the torchlight path is already known. */
  startWorker(): void {
    const logPath = this._resolveLogPath();
    if (logPath) this._worker.start(logPath);
  }

  // -- run lifecycle --------------------------------------------------------

  /** Start a fresh session (stops any run in progress first). */
  start(): void {
    this._start(newIdentity(), null);
  }

  /**
   * Continue a saved session: its new units append to it. Throws — before the
   * run in progress is touched — for an unknown id, a session whose rows are
   * not drop-through (their maths can't be extended), or the active session.
   */
  continueSession(sessionId: string): void {
    const loaded = this._deps.store.getSession(sessionId);
    if (!loaded) throw new Error(`Cannot continue session ${sessionId}: not found`);
    if (loaded.attribution !== 'drop-through') {
      throw new Error(`Cannot continue session ${sessionId}: ${loaded.attribution} attribution`);
    }
    if (sessionId === this.getActiveSessionId()) throw new Error(`Cannot continue session ${sessionId}: it is being tracked`);
    this._start({sessionId: loaded.id, name: loaded.name}, loaded);
  }

  stop(): void {
    try {
      if (this._engine) {
        this._log.info('engine', 'Engine stopped');
        this._engine.stop(); // emits the session tracker_finished → final write
      }
    } finally {
      this._engine      = null;
      this._persistence = null;
    }
    // Worker keeps running — it's independent
  }

  /**
   * Discard the run in progress and keep tracking under a new session: the
   * active session (continued or not) is DELETED with its rows. A no-op until
   * the session is open (the engine ignores a reset while initializing).
   */
  reset(): void {
    if (!this._engine?.isTracking() || !this._persistence) return;
    const oldId = this._persistence.getSessionId();
    this._deps.store.deleteSession(oldId);
    this._send({type: 'session_saved', sessionId: oldId, deleted: true});

    // Swapped BEFORE engine.reset: it emits the new session's tracker_started.
    const identity = newIdentity();
    this._persistence = this._newPersistence({...identity, continued: false, nextMapIndex: 1});
    this._engine.reset(identity);
    this._log.info('session', `Session reset: deleted id=${oldId}, new id=${identity.sessionId}`);
  }

  /** The tracked session's id while a run exists (initializing included), else null. */
  getActiveSessionId(): string | null {
    return this._engine ? this._persistence?.getSessionId() ?? null : null;
  }

  /** True while a run exists — from start() (initializing included) until stop(). */
  isTracking(): boolean {
    return this._engine !== null;
  }

  /** Delete a saved session and its rows. Refuses (throws) the active one. */
  deleteSession(sessionId: string): void {
    if (sessionId === this.getActiveSessionId()) throw new Error(`Cannot delete session ${sessionId}: it is being tracked`);
    this._deps.store.deleteSession(sessionId);
  }

  pause(): void {
    this._engine?.pause();
    this._log.info('engine', 'Engine paused');
  }

  resume(): void {
    this._engine?.resume();
    this._log.info('engine', 'Engine resumed');
  }

  /** App shutdown: stop (closing the active session), then the worker.
   *  Idempotent — window close, OS session end and app quit all call it. */
  shutdown(): void {
    if (this._shutDown) return;
    this._shutDown = true;
    try {
      this.stop();
    } finally {
      this._worker.stop();
    }
  }

  // -- engine pass-throughs (no-ops without a running engine) ---------------

  dismissMaterial(itemId: number): void {
    this._engine?.dismissMaterial(itemId);
  }

  /** Re-apply the settings table to the running engine. `overrides` win over
   *  the stored values, so a caller holding a value that may not be persisted
   *  yet (an `engine:set-*` IPC racing the renderer's `settings:set`) still
   *  applies it. */
  reconfigure(overrides?: Readonly<Record<string, string>>): void {
    this._engine?.configure({...this._deps.settings.getAll(), ...overrides});
  }

  setFilterRules(rules: FilterRule[] | null): void {
    if (!this._engine) return;
    this._engine.setFilterRules(rules);
    this._log.debug('filter', rules === null ? 'Filter cleared' : `Filter rules updated: ${rules.length} rules`);
  }

  /** An item's type changed (Items tab, name lookup): keep the engine's
   *  filter type-cache current so the next drop uses the new type. */
  setItemType(id: string, rawType: string): void {
    this._engine?.setItemType(id, mapRawType(rawType));
  }

  // -- private: lifecycle ---------------------------------------------------

  /** Stop any run, then start `identity`; `loaded` makes it a continue. */
  private _start(identity: SessionIdentity, loaded: DbSession | null): void {
    this.stop();
    this._shutDown = false;

    // Ensure the worker is running (idempotent — won't restart if already up)
    const logPath = this._resolveLogPath();
    if (logPath) this._worker.start(logPath);
    else         this._log.warn('worker', 'Torchlight path not set — log reader not started');

    this._engine = this._deps.createEngine(event => this._emit(event));

    if (loaded) {
      // After stop(): the stopped run may have written to the store.
      const nextMapIndex = this._deps.store.maxPrimaryMapIndex(loaded.id) + 1;
      this._persistence = this._newPersistence({...identity, continued: true, nextMapIndex});
      this._log.info('session', `Session continued: id=${loaded.id}, name="${loaded.name}", next map #${nextMapIndex}`);
      this._engine.loadSession({
        drops:         loaded.drops,
        dropsBySource: loaded.dropsBySource,
        spent:         loaded.spent,
        totalTime:     loaded.totalTime, // seconds — engine converts to ms
        mapTime:       loaded.mapTime,
        mapCount:      loaded.mapCount,
      });
    } else {
      this._persistence = this._newPersistence({...identity, continued: false, nextMapIndex: 1});
      this._log.info('session', `Session created: id=${identity.sessionId}`);
    }

    // Emits synchronously — engine and persistence must be set before this.
    this._engine.start(identity);

    // After start(): ctx.reset() inside it wipes the configuration.
    const activeFilter = this._deps.filters.getAll().find(f => f.enabled);
    configureEngine(this._engine, {
      items:       this._deps.items.getAll(),
      filterRules: activeFilter ? JSON.parse(activeFilter.rules) as FilterRule[] : null,
      settings:    this._deps.settings.getAll(),
    });
    if (activeFilter) this._log.info('filter', `Filter set: "${activeFilter.name}"`);

    this._log.info('engine', 'Engine started');
  }

  /** The game log path from the torchlight path in settings; null when unset. */
  private _resolveLogPath(): string | null {
    const torchlightPath = this._deps.settings.getAll()['torchlightPath'];
    if (!torchlightPath) return null;
    return `${torchlightPath}/${LOG_SUBPATH}`;
  }

  private _newPersistence(meta: SessionMeta): SessionPersistence {
    return new SessionPersistence(meta, {store: this._deps.store, readPrices: ids => this._readPrices(ids)});
  }

  /** Current price of every known item among `ids`. */
  private _readPrices(ids: ReadonlySet<string>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const item of this._deps.items.getAll()) {
      if (ids.has(item.id)) out[item.id] = item.price;
    }
    return out;
  }

  // -- private: worker events -----------------------------------------------

  /**
   * Routes a worker-emitted RawEvent. Price updates are processed even without
   * an active engine; everything else is forwarded to the engine if it's running.
   */
  private _onWorkerEvent(raw: RawEvent): void {
    if (raw.type === 'price_update') {
      const id     = String(raw.itemId);
      const locked = this._deps.items.getLocked(id);

      // History records every scrape, locked items included: the market showed that
      // price even if the user pinned the item's own value.
      const {priceDate} = this._deps.items.recordScrapedPrice(id, raw.price, raw.listings, {updateItem: !locked});
      if (locked) {
        this._log.debug('price', `Price update skipped (locked): item=${id} -> ${raw.price} FE`);
        return;
      }
      this._log.info('price', `Price update: item=${id} -> ${raw.price} FE`);

      // Sync renderer itemsStores via the unified items:changed broadcast.
      this._deps.broadcast('items:changed', {id, changes: {price: raw.price, ...(priceDate !== null && {priceDate})}});

      // Also emit the engine event so any other engine-event consumers (e.g. a
      // future "price updated" feed entry) keep working. The itemsStore no
      // longer reacts to this — items:changed is the source of truth.
      const event: EngineEvent = {type: 'price_update', itemId: raw.itemId, price: raw.price, timestamp: Date.now()};
      this._deps.broadcast('engine:event', event);
      return;
    }

    this._engine?.onRawEvent(raw);
  }

  // -- private: emit fan-out ------------------------------------------------

  /** Every engine event, in order: new-item insert → persistence (+ session_saved)
   *  → broadcast → wealth snapshot. Reads the CURRENT engine/persistence. */
  private _emit(event: EngineEvent): void {
    this._isolate('new_item',    event, () => this._recordNewItem(event));
    this._isolate('persistence', event, () => this._persist(event));
    this._send(event);
    this._isolate('wealth',      event, () => this._recordWealth(event));
  }

  /** Persist a placeholder row for newly discovered items so the renderer's
   *  items store (and all subsequent sessions) pick them up immediately. */
  private _recordNewItem(event: EngineEvent): void {
    if (event.type !== 'new_item') return;
    const id = String(event.itemId);
    if (this._deps.items.insertIfMissing(id)) this._log.info('database', `New item discovered: id=${id}`);
  }

  /**
   * Route every engine event through SessionPersistence, which writes the
   * session as the run goes. Each write is announced (`session_saved`) before
   * the event that caused it is broadcast.
   */
  private _persist(event: EngineEvent): void {
    if (!this._persistence) return;
    const outcome = this._persistence.onEngineEvent(event);
    if (!outcome) return;
    this._send('deletedId' in outcome
      ? {type: 'session_saved', sessionId: outcome.deletedId, deleted: true}
      : {type: 'session_saved', sessionId: outcome.savedId});
  }

  private _recordWealth(event: EngineEvent): void {
    if (!this._isWealthPoint(event)) return;
    if (this._engine) this._deps.wealthRecorder.snapshot(this._engine);
    this._send({type: 'wealth_recorded', timestamp: Date.now()});
  }

  /**
   * Wealth snapshots: session start, each map end, and the end of a
   * town-started seasonal run (last seasonal finished with no map alive —
   * such runs emit no map_ended, so without this their income wouldn't hit
   * the chart until the next map ends). During a normal map+seasonal town
   * return the map is still alive when seasonals finish, so only map_ended
   * snapshots — no double datapoint.
   */
  private _isWealthPoint(event: EngineEvent): boolean {
    if (event.type === 'init_complete' || event.type === 'map_ended') return true;
    return event.type === 'tracker_finished' && event.tracker.kind === 'seasonal'
      && this._engine !== null && !this._engine.hasActiveMapTracker() && !this._engine.hasActiveSeasonals();
  }

  private _send(event: EngineEvent): void {
    // `unit_finished` is persistence-only and stays in-process: the renderer
    // reads each tracker's own tracker_finished instead.
    if (event.type === 'unit_finished') return;
    this._isolate('broadcast', event, () => this._deps.broadcast('engine:event', event));
  }

  /** Run one emit consumer; a throw is logged and swallowed so the rest still run. */
  private _isolate(consumer: EmitConsumer, event: EngineEvent, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this._log.error('engine', `Emit consumer '${consumer}' failed on ${event.type}: ${err}`);
    }
  }
}
