import {describe, it, expect, vi, type MockInstance} from 'vitest';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {Engine} from '@/main/engine/engine';
import {createDispatcher} from '@/worker/create-dispatcher';
import {parseLogTimestamp, readLogText, type LogLine} from '@/replay/log-source';
import {replay, type ReplayOptions} from '@/replay/replay';
import {compareRows} from '@/replay/report';
import {createScrubber, REDACTED_RUN_ID} from '@/replay/scrub';
import type {DbSessionMap} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';

const T0 = Date.UTC(2026, 9, 25, 11, 0, 0, 0);

function stamp(offsetMs: number): string {
  const d = new Date(T0 + offsetMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `[${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}:${p(d.getUTCMilliseconds(), 3)}][ 12]`;
}

const TOWN = 'XZ_YuJinZhiXiBiNanSuo200';
const MAP  = '/Game/Art/Maps/S5_Boss';

const initLine = (ms: number, slot: number, item: number, qty: number) =>
  `${stamp(ms)}TLLua: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = ${slot} ConfigBaseId = ${item} Num = ${qty}`;
const modifyLine = (ms: number, slot: number, item: number, qty: number) =>
  `${stamp(ms)}TLLua: Display: [Game] BagMgr@:Modfy BagItem PageId = 102 SlotId = ${slot} ConfigBaseId = ${item} Num = ${qty}`;
const zoneLine = (ms: number, from: string, to: string) =>
  `${stamp(ms)}TLLua: Display: [Game] PageApplyBase@ _UpdateGameEnd: LastSceneName = World'${from}' NextSceneName = World'${to}'`;
const noise = (ms: number) => `${stamp(ms)}LogTemp: Display: nothing to see`;

function linesOf(text: string[]): LogLine[] {
  return [...readLogText(text.join('\n'))];
}

function at(events: Array<{event: EngineEvent; at: number}>, type: EngineEvent['type']): number[] {
  return events.filter(e => e.event.type === type).map(e => e.at);
}

/** Each replay persists into its own fresh DB. */
const run = (opts: Omit<ReplayOptions, 'persistence'>) =>
  replay({...opts, persistence: {store: new SqliteSessionStore(openMigratedNodeSqlite()), readPrices: () => ({})}});

describe('parseLogTimestamp', () => {
  it('reads the game prefix as UTC', () => {
    expect(parseLogTimestamp('[2026.10.25-11.04.33:448][701]TLGame: Display: x')).toBe(Date.UTC(2026, 9, 25, 11, 4, 33, 448));
  });

  it('returns null for a line without a prefix', () => {
    expect(parseLogTimestamp("PageApplyBase@ _UpdateGameEnd: LastSceneName = World'a'")).toBeNull();
  });
});

describe('readLogText', () => {
  it('inherits timestamps, strips \\r and drops blank or unplaceable lines', () => {
    const out = linesOf(['no stamp yet', `${noise(5)}\r`, 'continuation', '', noise(9)]);
    expect(out.map(l => [l.lineNo, l.ts - T0])).toEqual([[2, 5], [3, 5], [5, 9]]);
    expect(out[0].text.endsWith('\r')).toBe(false);
  });

  it('slices by line range and by time, inclusive', () => {
    const text = [noise(0), noise(10), noise(20), noise(30)].join('\n');
    expect([...readLogText(text, {fromLine: 2, toLine: 3})].map(l => l.lineNo)).toEqual([2, 3]);
    expect([...readLogText(text, {from: T0 + 10, to: T0 + 20})].map(l => l.lineNo)).toEqual([2, 3]);
  });
});

describe('replay clock', () => {
  const dump = [initLine(0, 1, 100, 5), initLine(1, 2, 200, 7), initLine(2, 3, 300, 9), noise(10_000)];

  it('fires the init debounce in log time (exact mode)', async () => {
    const r = await run({source: linesOf(dump), mode: 'exact'});
    expect(at(r.events, 'init_complete')).toEqual([T0 + 2 + 500]);
    expect(r.finalInventory).toEqual(new Map([[100, 5], [200, 7], [300, 9]]));
  });

  it('delivers poll-mode lines at the 250 ms watcher boundary', async () => {
    const r = await run({source: linesOf(dump), mode: 'poll'});
    // Lines at +1/+2 ms reach the engine with the +250 ms poll.
    expect(at(r.events, 'init_complete')).toEqual([T0 + 250 + 500]);
  });

  it('applies operator controls at their timestamps', async () => {
    const r = await run({
      source:   linesOf(dump),
      mode:     'exact',
      controls: [{at: T0 - 1, op: 'start'}, {at: T0 + 5_000, op: 'pause'}, {at: T0 + 6_000, op: 'resume'}],
    });
    const status = r.events.filter(e => e.event.type === 'session_status');
    expect(status.map(e => [e.at - T0, (e.event as {status: string}).status])).toEqual([[5_000, 'paused'], [6_000, 'running']]);
  });

  it('leaves real timers alone once finished', async () => {
    const before = Date.now();
    await run({source: linesOf(dump)});
    expect(Math.abs(Date.now() - before)).toBeLessThan(60_000);
  });

  it('refuses to run on top of other fake timers instead of sharing the globals', async () => {
    vi.useFakeTimers();
    try {
      await expect(run({source: linesOf(dump)})).rejects.toThrow(/twice/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('replay persistence', () => {
  const dump = [initLine(0, 1, 100, 5), initLine(1, 2, 200, 7), initLine(2, 3, 300, 9)];
  /** Town spend of one 300 just before entering, three 100s picked up in the map. */
  const mapRun = [
    ...dump,
    modifyLine(9_000, 3, 300, 8),
    zoneLine(9_500, TOWN, MAP),
    modifyLine(20_000, 1, 100, 8),
    zoneLine(40_000, MAP, TOWN),
    noise(45_000),
  ];

  it('saves the session and its map row through SessionPersistence', async () => {
    const r = await run({source: linesOf(mapRun), mode: 'exact'});
    expect(r.sessions).toHaveLength(1);
    const [s] = r.sessions;
    expect(s.id).toBe('replay-1');
    expect(s.session).toMatchObject({id: 'replay-1', name: 'replay-1', mapCount: 1, drops: {'100': 3, '300': -1}});
    expect(s.rows).toEqual([{
      sessionId:      'replay-1',
      mapIndex:       1,
      startedAt:      T0 + 9_500,
      duration:       30_500,
      drops:          {'100': 3, '300': -1},
      spent:          {'300': 1},
      seasonalType:   null,
      parentMapIndex: null,
      phase:          null,
    }]);
  });

  it('freezes session prices through the injected reader (own items, priced only)', async () => {
    const r = await replay({
      source:      linesOf(mapRun),
      persistence: {store: new SqliteSessionStore(openMigratedNodeSqlite()), readPrices: () => ({'100': 2.5, '999': 4})},
    });
    expect(r.sessions[0].session?.priceSnapshot).toEqual({'100': 2.5});
  });

  it('reports a run discarded by the 30 s rule as an unsaved session', async () => {
    const r = await run({source: linesOf(dump), settleMs: 1_000});
    expect(r.sessions).toEqual([{id: 'replay-1', session: null, rows: []}]);
  });

  it('saves each start as its own session, the stopped run under its own id', async () => {
    // Tracking starts at each run's own bag dump (init_complete).
    const redump = [initLine(41_000, 1, 100, 5), initLine(41_001, 2, 200, 7), initLine(41_002, 3, 300, 9)];
    const r = await run({
      source:   linesOf([...dump, ...redump, noise(50_000)]),
      mode:     'exact',
      controls: [{at: T0 - 1, op: 'start'}, {at: T0 + 40_000, op: 'start'}],
    });
    expect(r.sessions.map(s => s.id)).toEqual(['replay-1', 'replay-2']);
    // Run 1: init at +502 → stopped by the second start at +40 s. Run 2: init at
    // +41.502 s → end of the 60 s settle after the last line (+110 s).
    expect(r.sessions.map(s => s.session?.totalTime)).toEqual([39.498, 68.498]);
  });

  it('names sessions with the given id factory', async () => {
    const r = await run({source: linesOf(dump), sessionIds: n => `golden-${n}`});
    expect(r.sessions.map(s => s.session?.id)).toEqual(['golden-1']);
  });

  it('leaves an unfinished run unsaved without stopAtEnd', async () => {
    const r = await run({source: linesOf(mapRun), stopAtEnd: false});
    expect(r.sessions).toEqual([{id: 'replay-1', session: null, rows: []}]);
  });
});

describe('replay raw-event routing', () => {
  const net = (ms: number, body: string) => `${stamp(ms)}LogNet: ${body}`;
  const log = [
    initLine(0, 1, 100, 5),
    net(100, 'Socket SendMessage STT----XchgSearchPrice----SynId = 3'),
    net(101, '+typ3 [100]'),
    net(102, 'Socket SendMessage End'),
    net(200, 'Socket RecvMessage STT----XchgSearchPrice----SynId = 3'),
    net(201, '+unitPrices+1 [7.0]'),
    net(202, '+currency [100300]'),
    net(203, 'Socket RecvMessage End'),
    modifyLine(1_000, 1, 100, 6),
  ];

  it('never hands a price_update to the engine, as TrackingService does not', async () => {
    const d = createDispatcher();
    expect(log.flatMap(l => d.dispatch(l).map(e => e.type))).toEqual(['bag_init', 'price_update', 'bag_update']);

    let spy: MockInstance<Engine['onRawEvent']> | undefined;
    await run({source: linesOf(log), configure: engine => { spy = vi.spyOn(engine, 'onRawEvent'); }});
    expect(spy!.mock.calls.map(([raw]) => raw.type)).toEqual(['bag_init', 'bag_update']);
  });
});

describe('compareRows', () => {
  const row = (over: Partial<DbSessionMap>): DbSessionMap => ({
    sessionId: 's', mapIndex: 1, startedAt: T0, duration: 60_000, drops: {'100': 3}, spent: {},
    seasonalType: null, parentMapIndex: null, phase: null, ...over,
  });

  it('pairs a row whose start drifted but whose end matches', () => {
    const cmp = compareRows([row({startedAt: T0 + 16_000, duration: 44_000})], [row({})]);
    expect(cmp).toHaveLength(1);
    expect(cmp[0].stored).not.toBeNull();
    expect(cmp[0]).toMatchObject({drops: [], spent: [], fields: []});
  });

  it('reports unpaired rows on both sides', () => {
    const cmp = compareRows([row({seasonalType: 'arcana', duration: 1, drops: {}})], [row({spent: {'200': 1}})]);
    expect(cmp.map(c => [c.replay !== null, c.stored !== null])).toEqual([[true, false], [false, true]]);
    expect(cmp[1]).toMatchObject({
      drops:  [{itemId: '100', replayed: 0, stored: 3}],
      spent:  [{itemId: '200', replayed: 0, stored: 1}],
      fields: [],
    });
  });

  it('diffs spent like drops', () => {
    const cmp = compareRows([row({spent: {'200': 2, '300': 1}})], [row({spent: {'200': 1, '300': 1}})]);
    expect(cmp[0].drops).toEqual([]);
    expect(cmp[0].spent).toEqual([{itemId: '200', replayed: 2, stored: 1}]);
  });

  it('diffs mapIndex, parentMapIndex and phase of a paired row', () => {
    const cmp = compareRows(
      [row({seasonalType: 'sandlord', mapIndex: 2, parentMapIndex: 2, phase: 'map'})],
      [row({seasonalType: 'sandlord', mapIndex: 1, parentMapIndex: null, phase: 'hub'})],
    );
    expect(cmp[0].fields).toEqual([
      {field: 'mapIndex',       replayed: 2,     stored: 1},
      {field: 'parentMapIndex', replayed: 2,     stored: null},
      {field: 'phase',          replayed: 'map', stored: 'hub'},
    ]);
    expect(cmp[0].drops).toEqual([]);
  });
});

describe('createScrubber', () => {
  it('keeps only lines the processor chain parses and redacts Tartarus run ids', () => {
    const board = `${stamp(5)}TLLua: Display: [Game] [S16BGM] board Begin runId=cbd0465f-c985-11f1-858f-000000000137 IsSettled=false Result=-1`;
    const scrubber = createScrubber();
    const out = linesOf([initLine(0, 1, 100, 5), noise(1), board, noise(6), modifyLine(7, 1, 100, 6)]).map(l => scrubber.scrub(l));
    expect(out).toEqual([
      initLine(0, 1, 100, 5),
      null,
      `${stamp(5)}TLLua: Display: [Game] [S16BGM] board Begin ${REDACTED_RUN_ID} IsSettled=false Result=-1`,
      null,
      modifyLine(7, 1, 100, 6),
    ]);
    expect(scrubber.finish()).toBeNull();
    expect(scrubber.stats).toEqual({kept: 3, dropped: 2, unstamped: 0, anchors: 0});
  });

  it('replaces a dropped first and last line with bare time anchors', () => {
    const scrubber = createScrubber();
    const out = linesOf([noise(0), initLine(3, 1, 100, 5), noise(6), noise(9)]).map(l => scrubber.scrub(l));
    expect([...out, scrubber.finish()]).toEqual([
      '[2026.10.25-11.00.00:000]', initLine(3, 1, 100, 5), null, null, '[2026.10.25-11.00.00:009]',
    ]);
    expect(scrubber.stats).toEqual({kept: 1, dropped: 3, unstamped: 0, anchors: 2});
  });

  it('keeps a scrubbed slice on the raw slice clock', async () => {
    const raw = [
      noise(-1_400), initLine(0, 1, 100, 5), initLine(1, 2, 200, 7),
      modifyLine(9_000, 2, 200, 6), zoneLine(9_500, TOWN, MAP), modifyLine(20_100, 1, 100, 8),
      zoneLine(40_000, MAP, TOWN), noise(45_900),
    ];
    const scrubber = createScrubber();
    const kept = linesOf(raw).map(l => scrubber.scrub(l)).filter((t): t is string => t !== null);
    const closing = scrubber.finish();
    const scrubbed = closing === null ? kept : [...kept, closing];
    // One at a time: each replay installs the global fake clock.
    const a = await run({source: linesOf(raw)});
    const b = await run({source: linesOf(scrubbed)});
    expect(a.sessions[0].rows).toHaveLength(1);
    expect(b.sessions).toEqual(a.sessions);
  });

  it('counts kept lines that carry no timestamp of their own', () => {
    const scrubber = createScrubber();
    scrubber.scrub({lineNo: 1, ts: T0, text: `PageApplyBase@ _UpdateGameEnd: LastSceneName = World'${TOWN}' NextSceneName = World'${MAP}'`});
    expect(scrubber.stats).toEqual({kept: 1, dropped: 0, unstamped: 1, anchors: 0});
  });
});
