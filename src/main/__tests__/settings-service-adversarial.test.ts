/**
 * 3.2 adversarial: SettingsService failure semantics (persist is the commit
 * point), table-at-that-moment broadcasts, and the end-to-end chain with a real
 * TrackingService + engine behind it.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {SettingsService} from '@/main/settings-service';
import {TrackingService, type LogWorker, type TrackingDeps} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import {Engine} from '@/main/engine/engine';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import type {EngineEvent, SeasonalType} from '@/shared/contracts/engine';
import {unwrapEngineEvent} from '@/test/broadcast';
import {LOG_SUBPATH} from '@/shared/paths';
import {parseSettings, type Settings} from '@/shared/settings';
import {MAP, TOWN, createDispatcher, log} from '@/main/engine/__tests__/seasonal-fixtures';
import type {RawEvent} from '@/worker/processors/types';

interface Sent {channel: string; payload: unknown}

function build(over: {
  reconfigure?: () => void;
  reloadConfig?: () => void;
  broadcast?: () => void;
  set?: () => void;
  getAll?: () => void;
  initial?: Record<string, string>;
} = {}) {
  const table = new Map<string, string>(Object.entries(over.initial ?? {}));
  const sent: Sent[] = [];
  const calls: string[] = [];
  const errors: Array<[string, string]> = [];
  const service = new SettingsService({
    store: {
      set: (k, v) => { over.set?.(); table.set(k, v); calls.push(`persist:${k}`); },
      getAll: () => { over.getAll?.(); return Object.fromEntries(table); },
    },
    broadcast: (channel, payload) => { over.broadcast?.(); sent.push({channel, payload}); calls.push('broadcast'); },
    tracking: {reconfigure: () => { calls.push('reconfigure'); over.reconfigure?.(); }},
    log: {
      reloadConfig: () => { calls.push('reloadConfig'); over.reloadConfig?.(); },
      error:        (feature, message) => { errors.push([feature, message]); calls.push('error'); },
    },
  });
  return {service, table, sent, calls, errors};
}
const payloads = (sent: Sent[]) => sent.map(s => s.payload as Settings);

describe('SettingsService failure semantics (persist is the commit point)', () => {
  it('a throwing reconfigure: persisted, logged once, the broadcast still carries the value, set returns', () => {
    const h = build({reconfigure: () => { throw new Error('engine boom'); }});
    expect(() => h.service.set('carjackLootMs', '7000')).not.toThrow();
    expect(h.table.get('carjackLootMs')).toBe('7000');
    expect(h.calls).toEqual(['persist:carjackLootMs', 'reconfigure', 'error', 'broadcast']);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0][0]).toBe('app');
    expect(h.errors[0][1]).toContain('engine boom');
    expect(h.sent.map(s => s.channel)).toEqual(['settings:changed']);
    expect(payloads(h.sent)[0]).toEqual(parseSettings(Object.fromEntries(h.table)));
    expect(payloads(h.sent)[0].lootWindowMs.carjack).toBe(7000);
  });

  it('a throwing reloadConfig: persisted, logged once, the broadcast still goes out, set returns', () => {
    const h = build({reloadConfig: () => { throw new Error('log boom'); }});
    expect(() => h.service.set('logging.file', 'true')).not.toThrow();
    expect(h.table.get('logging.file')).toBe('true');
    expect(h.calls).toEqual(['persist:logging.file', 'reloadConfig', 'error', 'broadcast']);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0][0]).toBe('app');
    expect(h.errors[0][1]).toContain('log boom');
    expect(h.sent.map(s => s.channel)).toEqual(['settings:changed']);
  });

  it('a non-Error throw from a side effect is logged too, and the write still commits', () => {
    const h = build({reconfigure: () => { throw 'plain string'; }});
    expect(() => h.service.set('lowStockThreshold', '4')).not.toThrow();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0][1]).toContain('plain string');
    expect(payloads(h.sent)[0].lowStockThreshold).toBe(4);
  });

  it('a side effect failing once does not stick: the next write reconfigures and broadcasts normally', () => {
    let fail = true;
    const h = build({reconfigure: () => { if (fail) throw new Error('once'); }});
    h.service.set('carjackLootMs', '7000');
    fail = false;
    h.service.set('carjackLootMs', '6000');
    expect(h.errors).toHaveLength(1);
    expect(h.calls.filter(c => c === 'reconfigure')).toHaveLength(2);
    expect(payloads(h.sent).map(s => s.lootWindowMs.carjack)).toEqual([7000, 6000]);
  });

  it('a throwing broadcast: persisted and reconfigured, error propagates', () => {
    const h = build({broadcast: () => { throw new Error('send boom'); }});
    expect(() => h.service.set('lowStockThreshold', '3')).toThrow('send boom');
    expect(h.table.get('lowStockThreshold')).toBe('3');
    expect(h.calls).toEqual(['persist:lowStockThreshold', 'reconfigure']);
    expect(h.errors).toEqual([]);
  });

  it('a throwing persist does nothing else (no reconfigure, no reload, no broadcast, no log)', () => {
    const h = build({set: () => { throw new Error('disk full'); }});
    for (const key of ['carjackLootMs', 'logging.console', 'themeMode']) {
      expect(() => h.service.set(key, 'x')).toThrow('disk full');
    }
    expect(h.calls).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.errors).toEqual([]);   // the caller's invoke rejects; nothing to log here
  });

  it('a getAll that throws AFTER persist and side effects: persisted + reconfigured, no broadcast', () => {
    let armed = false;
    const h = build({getAll: () => { if (armed) throw new Error('read boom'); }});
    armed = true;
    expect(() => h.service.set('carjackLootMs', '7000')).toThrow('read boom');
    expect(h.table.get('carjackLootMs')).toBe('7000');
    expect(h.calls).toEqual(['persist:carjackLootMs', 'reconfigure']);
    expect(h.sent).toEqual([]);
  });
});

describe('SettingsService table handling', () => {
  it('a table that already holds invalid values broadcasts defaults for them and never throws', () => {
    const h = build({initial: {carjackLootMs: 'abc', overlayOpacity: 'zzz', themeMode: 'neon', lowStockThreshold: '-4'}});
    h.service.set('rateTimeframe', 'minute');
    const s = payloads(h.sent)[0];
    expect(s).toEqual({...parseSettings({}), rateTimeframe: 'minute'});
  });

  it('writing an invalid value for a key persists the RAW string (service never sanitises) but broadcasts the default', () => {
    const h = build();
    h.service.set('carjackLootMs', '-5');
    expect(h.table.get('carjackLootMs')).toBe('-5');
    expect(payloads(h.sent)[0].lootWindowMs.carjack).toBe(5000);
    expect(h.calls).toEqual(['persist:carjackLootMs', 'reconfigure', 'broadcast']);   // reconfigure still fires (engine falls back)
  });

  it('repeated identical writes: each one persists, reconfigures and broadcasts (no dedupe)', () => {
    const h = build();
    for (let i = 0; i < 3; i++) h.service.set('themeMode', 'dark');
    h.service.set('lowStockThreshold', '2');
    h.service.set('lowStockThreshold', '2');
    expect(h.sent).toHaveLength(5);
    expect(h.calls.filter(c => c === 'reconfigure')).toHaveLength(2);
  });

  it('interleaved keys: each broadcast reflects the table at that moment, and is a distinct object', () => {
    const h = build();
    h.service.set('themeMode', 'dark');
    h.service.set('carjackLootMs', '7000');
    h.service.set('themeMode', 'light');
    h.service.set('carjackLootMs', '1');
    const [a, b, c, d] = payloads(h.sent);
    expect([a.themeMode, a.lootWindowMs.carjack]).toEqual(['dark', 5000]);
    expect([b.themeMode, b.lootWindowMs.carjack]).toEqual(['dark', 7000]);
    expect([c.themeMode, c.lootWindowMs.carjack]).toEqual(['light', 7000]);
    expect([d.themeMode, d.lootWindowMs.carjack]).toEqual(['light', 1]);
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(new Set([a, b, c, d].map(s => s.lootWindowMs)).size).toBe(4);
  });

  it('mutating a broadcast payload does not corrupt the next one', () => {
    const h = build();
    h.service.set('themeMode', 'dark');
    (payloads(h.sent)[0].lootWindowMs as Record<string, number>)['carjack'] = 1;
    h.service.set('themeMode', 'light');
    expect(payloads(h.sent)[1].lootWindowMs.carjack).toBe(5000);
  });

  it('key classification is exact: lookalikes trigger neither side effect', () => {
    const h = build();
    for (const key of ['Logging.console', 'logging', 'loggingX', ' logging.file', 'carjackLootMS', 'lowStockThreshold ', '']) {
      h.service.set(key, '1');
    }
    expect(h.calls.filter(c => c === 'reconfigure' || c === 'reloadConfig')).toEqual([]);
  });

  it('only the exact "logging." prefix reloads the logger, and a logging key never reconfigures the engine', () => {
    const h = build();
    h.service.set('logging.', 'x');
    h.service.set('logging.console', 'x');
    expect(h.calls.filter(c => c === 'reloadConfig')).toHaveLength(2);
    expect(h.calls).not.toContain('reconfigure');
  });

  it('getAll returns the store table verbatim', () => {
    const h = build({initial: {a: '1', 'serper_api_key': 'k'}});
    expect(h.service.getAll()).toEqual({a: '1', serper_api_key: 'k'});
  });
});

// ---- end to end: real TrackingService + engine behind a SettingsService -------

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const ITEM = 100;

type WindowStarted = Extract<EngineEvent, {type: 'loot_window_started'}>;

function e2e(initial: Record<string, string> = {torchlightPath: TORCHLIGHT}) {
  const table: Record<string, string> = {...initial};
  const events: EngineEvent[] = [];
  const settingsBroadcasts: Sent[] = [];
  let onEvent!: (raw: RawEvent) => void;
  const noop = vi.fn();
  const worker = {start: vi.fn(), stop: vi.fn()};
  const tracking = new TrackingService({
    createEngine:   emit => createProductionEngine(emit),
    store:          new SqliteSessionStore(openMigratedNodeSqlite()),
    broadcast:      (channel, payload) => { if (channel === 'engine:event') events.push(unwrapEngineEvent(payload)); },
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => table},
    filters:        {getAll: () => []},
    items: {
      getAll: () => [], getLocked: () => false, insertIfMissing: () => true,
      recordScrapedPrice: () => ({priceDate: Date.now()}),
    } as unknown as TrackingDeps['items'],
    wealthRecorder: {snapshot: noop},
    log:            {debug: noop, info: noop, warn: noop, error: noop},
  });
  const reloadConfig = vi.fn();
  const logError = vi.fn();
  const settings = new SettingsService({
    store: {set: (k, v) => { table[k] = v; }, getAll: () => ({...table})},
    broadcast: (channel, payload) => { settingsBroadcasts.push({channel, payload}); },
    tracking,
    log: {reloadConfig, error: logError},
  });
  const d = createDispatcher();
  const feed = (l: string) => { for (const ev of d.dispatch(l)) onEvent(ev); };
  const initBag = () => { feed(log.bagInit(1, ITEM, 10)); feed(log.bagInit(2, 900, 1)); vi.advanceTimersByTime(600); };
  return {tracking, settings, table, events, settingsBroadcasts, reloadConfig, logError, feed, initBag, logPath: `${TORCHLIGHT}/${LOG_SUBPATH}`};
}
type Rig = ReturnType<typeof e2e>;

const windowsOf = (events: EngineEvent[], type: SeasonalType, from = 0): number[] =>
  events.slice(from)
    .filter((ev): ev is WindowStarted => ev.type === 'loot_window_started' && ev.seasonalType === type)
    .map(ev => ev.deadline - ev.timestamp);

const ARM: Record<'carjack' | 'sandlord', string[]> = {carjack: [log.s11Start], sandlord: [log.s10Wave]};

/** town -> map, arm `type`, back to town; the windows it armed. */
function runMap(r: Rig, type: 'carjack' | 'sandlord'): number[] {
  const at = r.events.length;
  r.feed(log.zoneTransition(TOWN, MAP));
  for (const l of ARM[type]) r.feed(l);
  const w = windowsOf(r.events, type, at);
  r.feed(log.zoneTransition(MAP, TOWN));
  return w;
}

describe('settings -> real tracking service (end to end)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([['carjack', 'carjackLootMs'], ['sandlord', 'sandlordWaveMs']] as const)(
    'set %s window while tracking: the NEXT run uses it, the broadcast carries it', (type, key) => {
      const r = e2e();
      r.tracking.start();
      r.initBag();
      expect(runMap(r, type)).toEqual([type === 'carjack' ? 5000 : 10000]);

      r.settings.set(key, '2500');
      expect(runMap(r, type)).toEqual([2500]);
      const last = r.settingsBroadcasts.at(-1)!;
      expect(last.channel).toBe('settings:changed');
      expect((last.payload as Settings).lootWindowMs[type]).toBe(2500);
    });

  it('a live tracker keeps its window: the change lands only on the next run', () => {
    const r = e2e();
    r.tracking.start();
    r.initBag();
    r.feed(log.zoneTransition(TOWN, MAP));
    r.feed(log.s11Start);
    const at = r.events.length;
    r.settings.set('carjackLootMs', '2500');
    r.feed(log.s11Start);                                  // idempotent restart of the SAME live tracker
    expect(windowsOf(r.events, 'carjack', at).every(w => w === 5000)).toBe(true);
    r.feed(log.zoneTransition(MAP, TOWN));
    expect(runMap(r, 'carjack')).toEqual([2500]);
  });

  it('set with no engine: harmless, persisted, broadcast sent; the next start uses the stored value', () => {
    const r = e2e();
    expect(r.tracking.isTracking()).toBe(false);
    const configure = vi.spyOn(Engine.prototype, 'configure');
    expect(() => r.settings.set('carjackLootMs', '2500')).not.toThrow();
    expect(configure).not.toHaveBeenCalled();
    expect(r.table['carjackLootMs']).toBe('2500');
    expect(r.settingsBroadcasts).toHaveLength(1);

    r.tracking.start();
    r.initBag();
    expect(configure).toHaveBeenCalledTimes(1);
    expect(runMap(r, 'carjack')).toEqual([2500]);
  });

  it('after stop, a set is harmless and the next start picks it up', () => {
    const r = e2e();
    r.tracking.start();
    r.initBag();
    r.tracking.stop();
    r.settings.set('sandlordWaveMs', '1500');
    r.tracking.start();
    r.initBag();
    expect(runMap(r, 'sandlord')).toEqual([1500]);
  });

  it('lowStockThreshold while tracking reaches the engine as the parsed value; non-engine keys never reconfigure', () => {
    const r = e2e();
    r.tracking.start();
    r.initBag();
    const configure = vi.spyOn(Engine.prototype, 'configure');
    r.settings.set('lowStockThreshold', '0');
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0][0].lowStockThreshold).toBe(0);
    r.settings.set('lowStockThreshold', '12');
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({lowStockThreshold: 12}));

    configure.mockClear();
    for (const key of ['themeMode', 'language', 'overlayOpacity', 'serper_api_key', 'wealthChartRange',
      'logging.console', 'torchlightPath', 'auctionTaxEnabled', 'main_window_x', 'rateTimeframe']) {
      r.settings.set(key, 'dark');
    }
    expect(configure).not.toHaveBeenCalled();
    expect(r.reloadConfig).toHaveBeenCalledTimes(1);
    expect(r.settingsBroadcasts).toHaveLength(2 + 10);
  });

  it('an invalid engine value written while tracking falls back to the default window, not zero', () => {
    const r = e2e({torchlightPath: TORCHLIGHT, carjackLootMs: '7000'});
    r.tracking.start();
    r.initBag();
    expect(runMap(r, 'carjack')).toEqual([7000]);
    r.settings.set('carjackLootMs', '0');
    expect(runMap(r, 'carjack')).toEqual([5000]);
  });

  it('a throwing engine reconfigure: the write commits, both windows hear it, the error is logged', () => {
    const r = e2e();
    r.tracking.start();
    r.initBag();
    const configure = vi.spyOn(Engine.prototype, 'configure').mockImplementationOnce(() => { throw new Error('configure boom'); });
    expect(() => r.settings.set('carjackLootMs', '2500')).not.toThrow();
    expect(r.table['carjackLootMs']).toBe('2500');
    expect(r.settingsBroadcasts).toHaveLength(1);
    expect((r.settingsBroadcasts[0].payload as Settings).lootWindowMs.carjack).toBe(2500);
    expect(r.logError).toHaveBeenCalledTimes(1);
    expect(r.logError).toHaveBeenCalledWith('app', expect.stringContaining('configure boom'));
    configure.mockRestore();
    r.settings.set('carjackLootMs', '2600');   // the next engine write reconfigures normally
    expect(runMap(r, 'carjack')).toEqual([2600]);
  });
});
