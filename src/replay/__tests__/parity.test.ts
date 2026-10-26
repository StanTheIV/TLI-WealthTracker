/**
 * Replay <-> TrackingService parity: the same log, delivered the same way
 * (every line at its own timestamp, same controls), must save the same session
 * and rows through replay() and through a TrackingService over a fake worker.
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {TrackingService} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine} from '@/main/engine/create-engine';
import type {DbSession, DbSessionMap} from '@/shared/contracts/db';
import {formatLogTimestamp, readLogText, type LogLine} from '@/replay/log-source';
import {replay, type ControlOp} from '@/replay/replay';
import {createDispatcher} from '@/worker/create-dispatcher';
import type {RawEvent} from '@/worker/processors/types';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {GOLDEN_ITEMS} from '@/test/golden/items';
import {SYNTHETIC_FIXTURES} from '@/test/golden/synthetic';
import {readFileSync} from 'fs';
import {join} from 'path';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0, 0);
const SETTLE = 60_000;

const prices = (ids: ReadonlySet<string>) => {
  const out: Record<string, number> = {};
  for (const id of ids) if (GOLDEN_ITEMS[id]) out[id] = GOLDEN_ITEMS[id].price;
  return out;
}

interface Saved {session: Omit<DbSession, 'id' | 'name' | 'savedAt'> | null; rows: Array<Omit<DbSessionMap, 'sessionId'>>}

function strip(session: DbSession | null, rows: DbSessionMap[]): Saved {
  return {
    session: session && (({id: _i, name: _n, savedAt: _s, ...rest}) => rest)(session),
    rows:    rows.map(({sessionId: _id, ...r}) => r),
  };
}

async function viaReplay(lines: LogLine[], controls: ControlOp[]): Promise<Saved[]> {
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  const {configureEngine} = await import('@/main/engine/configure-engine');
  const res = await replay({
    source: lines, mode: 'exact', controls, settleMs: SETTLE,
    persistence: {store, readPrices: prices},
    configure: e => configureEngine(e, {items: Object.values(GOLDEN_ITEMS), filterRules: null, settings: {}}),
  });
  return res.sessions.map(s => strip(s.session, s.rows));
}

async function viaService(lines: LogLine[], controls: ControlOp[]): Promise<Saved[]> {
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  let onEvent!: (raw: RawEvent) => void;
  const ids: string[] = [];
  const service = new TrackingService({
    createEngine,
    store,
    broadcast: () => {},
    createWorker: cb => { onEvent = cb; return {start: () => {}, stop: () => {}}; },
    settings: {getAll: () => ({})},
    filters:  {getAll: () => []},
    items: {
      getAll: () => Object.values(GOLDEN_ITEMS),
      getLocked: () => false,
      insertIfMissing: () => false,
      recordScrapedPrice: () => ({priceDate: null}),
    },
    wealthRecorder: {snapshot: () => {}},
    log: {debug: () => {}, info: (_f: string, m: string) => { const id = /Session created: id=([0-9a-f-]+)/.exec(m)?.[1]; if (id) ids.push(id); }, warn: () => {}, error: () => {}},
  });
  vi.useFakeTimers({now: lines[0].ts - 1});
  try {
    const pending = [...controls].sort((a, b) => a.at - b.at);
    const advanceTo = (ts: number) => { if (ts > Date.now()) vi.advanceTimersByTime(ts - Date.now()); };
    const apply = (op: ControlOp['op']) => {
      if (op === 'start') service.start();
      else if (op === 'pause') service.pause();
      else if (op === 'resume') service.resume();
      else service.stop();
    };
    const upTo = (ts: number) => {
      while (pending.length && pending[0].at <= ts) { const c = pending.shift()!; advanceTo(c.at); apply(c.op); }
    };
    if (!controls.some(c => c.op === 'start')) service.start();
    const dispatcher = createDispatcher();
    for (const line of lines) {
      upTo(line.ts);
      advanceTo(line.ts);
      for (const raw of dispatcher.dispatch(line.text)) onEvent(raw);
    }
    const end = Date.now() + SETTLE;
    upTo(end);
    advanceTo(end);
    service.stop();
  } finally {
    vi.useRealTimers();
  }
  // The service names sessions by random uuid; read each started run back.
  return ids.map(id => strip(store.getSession(id), store.getRows(id)));
}

const lines = (text: string) => [...readLogText(text)];
const real = (name: string) => readFileSync(join(__dirname, '../../test/golden/fixtures', `${name}.log`), 'utf8');

const SCENARIOS: Array<[string, () => string]> = [
  ['map-vorex', () => SYNTHETIC_FIXTURES['map-vorex']],
  ['carjack', () => SYNTHETIC_FIXTURES['carjack-stop-after-dormancy']],
  ['afterlight', () => SYNTHETIC_FIXTURES['afterlight-special-no-win']],
  ['plain-map-cost', () => real('plain-map-cost')],
  ['map-arcana-map', () => real('map-arcana-map')],
];

afterEach(() => { vi.useRealTimers(); });

/** The vorex scenario with a market price block (SendMessage + RecvMessage) inside the map. */
function withPriceBlock(text: string): string {
  const stamp = (ms: number) => formatLogTimestamp(T0 + ms);
  const block = [
    [31_000, 'Socket SendMessage STT----XchgSearchPrice----SynId = 9'],
    [31_001, '+typ3 [6153]'],
    [31_002, 'Socket SendMessage End'],
    [31_500, 'Socket RecvMessage STT----XchgSearchPrice----SynId = 9'],
    [31_501, '+unitPrices+1 [999.0]'],
    [31_502, '+currency [100300]'],
    [31_503, 'Socket RecvMessage End'],
  ].map(([ms, body]) => `${stamp(ms as number)}[1]LogNet: ${body}`);
  const out = text.split('\n').filter(Boolean);
  const at = out.findIndex(l => l.startsWith(stamp(35_000)));
  out.splice(at, 0, ...block);
  return out.join('\n') + '\n';
}

describe('replay vs TrackingService parity (exact delivery)', () => {
  it.each(SCENARIOS)('%s: same saved session and rows', async (_n, text) => {
    const l = lines(text());
    const a = await viaReplay(l, []);
    const b = await viaService(l, []);
    expect(a[0].session).not.toBeNull();
    expect(a[0].rows.length).toBeGreaterThan(0);
    expect(b).toEqual([a[0]]);
  });

  it('price_update raw events (forwarded by replay, intercepted by the service) change nothing', async () => {
    const text = withPriceBlock(SYNTHETIC_FIXTURES['map-vorex']);
    const l = lines(text);
    expect(l.length).toBeGreaterThan(lines(SYNTHETIC_FIXTURES['map-vorex']).length);
    const a = await viaReplay(l, []);
    const b = await viaService(l, []);
    expect(b).toEqual([a[0]]);
    // ...and the price in the block does not leak into the run's own price snapshot.
    expect(a[0].session!.priceSnapshot['6153']).toBe(GOLDEN_ITEMS['6153'].price);
    expect(a).toEqual(await viaReplay(lines(SYNTHETIC_FIXTURES['map-vorex']), []));
  });

  it('pause then resume mid-map: same result', async () => {
    const l = lines(SYNTHETIC_FIXTURES['map-vorex']);
    const controls: ControlOp[] = [{at: T0 + 33_000, op: 'pause'}, {at: T0 + 50_000, op: 'resume'}];
    const a = await viaReplay(l, controls);
    const b = await viaService(l, controls);
    expect(b).toEqual([a[0]]);
  });

  it('stop mid-map with an overlap staged: nothing leaks, both agree', async () => {
    const l = lines(SYNTHETIC_FIXTURES['map-vorex']);
    const controls: ControlOp[] = [{at: T0 + 50_000, op: 'stop'}];
    const a = await viaReplay(l, controls);
    const b = await viaService(l, controls);
    expect(a[0].session).not.toBeNull();
    expect(b).toEqual([a[0]]);
  });

  it('a second start mid-run saves the first run, then the second', async () => {
    const l = lines(SYNTHETIC_FIXTURES['carjack-stop-after-dormancy']);
    const controls: ControlOp[] = [{at: T0 + 1, op: 'start'}, {at: T0 + 55_000, op: 'start'}];
    const a = await viaReplay(l, controls);
    const b = await viaService(l, controls);
    expect(a).toHaveLength(2);
    expect(b).toEqual(a);
  });
});
