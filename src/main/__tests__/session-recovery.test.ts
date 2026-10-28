/**
 * Startup crash-close: a session still open (`ended_at` NULL) at launch belongs
 * to a run that never reached Stop. Empty ones (under 30 s, no drops, no spent,
 * no rows) are deleted, the rest are closed at their last update (`saved_at`).
 */
import {describe, it, expect, beforeEach, afterEach, vi, type Mock} from 'vitest';
import {closeCrashedSessions} from '@/main/session-recovery';
import {TrackingService} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine} from '@/main/engine/create-engine';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import type {RawEvent} from '@/worker/processors/types';
import type {SqlConn} from '@/main/db/sql-conn';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {TOWN, MAP} from '@/main/engine/__tests__/seasonal-fixtures';

const activeIdOf = (s: TrackingService): string => s.getActiveSessionId()!;

const SAVED_AT = '2026-10-01T10:00:00.000Z';

let conn: SqlConn;
let store: SqliteSessionStore;
type LogFn = (feature: string, message: string) => void;
let log: {debug: Mock<LogFn>; info: Mock<LogFn>; warn: Mock<LogFn>; error: Mock<LogFn>};

beforeEach(() => {
  conn  = openMigratedNodeSqlite();
  store = new SqliteSessionStore(conn);
  log   = {debug: vi.fn<LogFn>(), info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>()};
});

afterEach(() => { vi.useRealTimers(); });

function session(id: string, over: Partial<DbSession> = {}): DbSession {
  return {
    id, name: id, savedAt: SAVED_AT, totalTime: 0, mapTime: 0, mapCount: 0, drops: {}, dropsBySource: {},
    attribution: 'drop-through', priceSnapshot: {}, spent: {}, endedAt: null, ...over,
  };
}

const row = (sessionId: string, mapIndex = 1): DbSessionMap => ({
  sessionId, mapIndex, startedAt: 1, endedAt: 2, duration: 1, drops: {}, spent: {}, seasonalType: null, parentMapIndex: null, phase: null,
});

const run = () => closeCrashedSessions(store, log);
const logged = () => [log.debug, log.info, log.warn].reduce((n, f) => n + f.mock.calls.length, 0);

describe('closeCrashedSessions', () => {
  it('closes an open session with content at its last update (saved_at), totals untouched', () => {
    store.insertSession(session('a', {totalTime: 300, mapCount: 3, drops: {'100': 5}}));
    store.insertRows([row('a'), row('a', 2)]);

    run();

    expect(store.getSession('a')).toEqual(session('a', {totalTime: 300, mapCount: 3, drops: {'100': 5}, endedAt: Date.parse(SAVED_AT)}));
    expect(store.getRows('a')).toHaveLength(2);
    expect(store.listOpenSessions()).toEqual([]);
  });

  it('deletes an open session under 30 s with no drops, no spent and no rows', () => {
    store.insertSession(session('empty', {totalTime: 12}));

    run();

    expect(store.getSession('empty')).toBeNull();
    expect(store.listSessions()).toEqual([]);
  });

  it.each([
    ['drops',          {totalTime: 5, drops: {'100': 1}}, false],
    ['spent',          {totalTime: 5, spent: {'42': 2}},  false],
    ['rows',           {totalTime: 5},                    true],
    ['exactly 30 s',   {totalTime: 30},                   false],
    ['more than 30 s', {totalTime: 3600},                 false],
  ] as const)('keeps (closes) an open session that has %s', (_label, over, withRows) => {
    store.insertSession(session('a', over));
    if (withRows) store.insertRows([row('a')]);

    run();

    expect(store.getSession('a')).toMatchObject({endedAt: Date.parse(SAVED_AT)});
    expect(store.getRows('a')).toHaveLength(withRows ? 1 : 0);
  });

  it('a deleted session takes its (zero) rows with it and leaves other sessions alone', () => {
    store.insertSession(session('empty', {totalTime: 1}));
    store.insertSession(session('keep', {totalTime: 100}));
    store.insertRows([row('keep')]);

    run();

    expect(store.listSessions().map(s => s.id)).toEqual(['keep']);
    expect(store.getRows('keep')).toHaveLength(1);
  });

  it('each session is closed at its OWN saved_at', () => {
    store.insertSession(session('a', {totalTime: 100, savedAt: '2026-10-01T10:00:00.000Z'}));
    store.insertSession(session('b', {totalTime: 100, savedAt: '2026-10-02T11:30:00.000Z'}));

    run();

    expect(store.getSession('a')!.endedAt).toBe(Date.parse('2026-10-01T10:00:00.000Z'));
    expect(store.getSession('b')!.endedAt).toBe(Date.parse('2026-10-02T11:30:00.000Z'));
  });

  it('already closed sessions are untouched, even short empty ones', () => {
    const closedEmpty = session('c1', {totalTime: 3, endedAt: 12345});
    const closedFull  = session('c2', {totalTime: 600, drops: {'1': 1}, endedAt: 67890});
    store.insertSession(closedEmpty);
    store.insertSession(closedFull);

    run();

    expect(store.getSession('c1')).toEqual(closedEmpty);
    expect(store.getSession('c2')).toEqual(closedFull);
  });

  it('is idempotent: a second run changes nothing', () => {
    store.insertSession(session('a', {totalTime: 100}));
    store.insertSession(session('gone', {totalTime: 1}));
    run();
    const after = store.listSessions();

    run();

    expect(store.listSessions()).toEqual(after);
  });

  it('with nothing open it is a no-op', () => {
    store.insertSession(session('c', {totalTime: 100, endedAt: 5}));
    expect(() => run()).not.toThrow();
    expect(store.getSession('c')!.endedAt).toBe(5);
  });

  it('logs what it did', () => {
    store.insertSession(session('a', {totalTime: 100}));
    store.insertSession(session('gone', {totalTime: 1}));

    run();

    expect(logged()).toBeGreaterThan(0);
  });
});

describe('closeCrashedSessions after an abandoned TrackingService run', () => {
  const NOW = new Date('2026-03-01T12:00:00Z').getTime();

  function startService(shared: SqlConn) {
    const svcStore = new SqliteSessionStore(shared);
    let onEvent!: (raw: RawEvent) => void;
    const noop = vi.fn();
    const service = new TrackingService({
      createEngine,
      store:          svcStore,
      broadcast:      () => {},
      createWorker:   cb => { onEvent = cb; return {start: vi.fn(), stop: vi.fn()}; },
      settings:       {getAll: () => ({torchlightPath: 'C:/Games/TLI'})},
      filters:        {getAll: () => []},
      items:          {getAll: () => [], getLocked: () => false, insertIfMissing: () => false, recordScrapedPrice: () => ({priceDate: null})},
      wealthRecorder: {snapshot: noop},
      log:            {debug: noop, info: noop, warn: noop, error: noop},
    });
    const raw = (e: RawEvent) => onEvent(e);
    const init = () => {
      raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
      raw({type: 'bag_snapshot_start'});
    };
    const runMap = () => {
      raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
      raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 3});
      vi.advanceTimersByTime(60_000);
      raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
    };
    return {service, init, runMap};
  }

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });

  it('a run with a finished map, never stopped: closed at its last write, map and totals intact', () => {
    const run1 = startService(conn);
    run1.service.start();
    run1.init();
    run1.runMap();
    const id = activeIdOf(run1.service);
    const lastWrite = store.getSession(id)!.savedAt;
    expect(store.getSession(id)!.endedAt).toBeNull();
    // The app dies here: no stop(), no shutdown().

    const fresh = new SqliteSessionStore(conn);
    closeCrashedSessions(fresh, log);

    const saved = fresh.getSession(id)!;
    expect(saved.endedAt).toBe(Date.parse(lastWrite));
    expect(saved).toMatchObject({mapCount: 1, drops: {'200': 3}});
    expect(fresh.getRows(id)).toMatchObject([{mapIndex: 1, drops: {'200': 3}}]);
    expect(fresh.listOpenSessions()).toEqual([]);
  });

  it('a run abandoned right after init (under 30 s, nothing in it) is deleted', () => {
    const run1 = startService(conn);
    run1.service.start();
    run1.init();
    const id = activeIdOf(run1.service);
    expect(store.getSession(id)).not.toBeNull();

    const fresh = new SqliteSessionStore(conn);
    closeCrashedSessions(fresh, log);

    expect(fresh.getSession(id)).toBeNull();
    expect(fresh.listSessions()).toEqual([]);
  });

  it('a run that had not even finished init left nothing to close', () => {
    const run1 = startService(conn);
    run1.service.start();
    const fresh = new SqliteSessionStore(conn);

    closeCrashedSessions(fresh, log);

    expect(fresh.listSessions()).toEqual([]);
  });

  it('the cleanly stopped run next to the crashed one is left alone', () => {
    const done = startService(conn);
    done.service.start();
    done.init();
    done.runMap();
    done.service.stop();
    const doneId = store.listSessions()[0].id;
    const doneBefore = store.getSession(doneId);

    const crashed = startService(conn);
    crashed.service.start();
    crashed.init();
    crashed.runMap();

    closeCrashedSessions(new SqliteSessionStore(conn), log);

    expect(store.getSession(doneId)).toEqual(doneBefore);
    expect(store.listOpenSessions()).toEqual([]);
    expect(store.listSessions()).toHaveLength(2);
  });
});
