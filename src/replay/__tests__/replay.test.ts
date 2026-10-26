import {describe, it, expect, vi} from 'vitest';
import {parseLogTimestamp, readLogText, type LogLine} from '@/replay/log-source';
import {replay} from '@/replay/replay';
import {compareRows, type StoredRow} from '@/replay/report';
import type {EngineEvent} from '@/shared/contracts/engine';

const T0 = Date.UTC(2026, 9, 25, 11, 0, 0, 0);

function stamp(offsetMs: number): string {
  const d = new Date(T0 + offsetMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `[${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}.${p(d.getUTCMinutes())}.${p(d.getUTCSeconds())}:${p(d.getUTCMilliseconds(), 3)}][ 12]`;
}

const initLine = (ms: number, slot: number, item: number, qty: number) =>
  `${stamp(ms)}TLLua: Display: [Game] BagMgr@:InitBagData PageId = 102 SlotId = ${slot} ConfigBaseId = ${item} Num = ${qty}`;
const noise = (ms: number) => `${stamp(ms)}LogTemp: Display: nothing to see`;

function linesOf(text: string[]): LogLine[] {
  return [...readLogText(text.join('\n'))];
}

function at(events: Array<{event: EngineEvent; at: number}>, type: EngineEvent['type']): number[] {
  return events.filter(e => e.event.type === type).map(e => e.at);
}

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
    const r = await replay({source: linesOf(dump), mode: 'exact'});
    expect(at(r.events, 'init_complete')).toEqual([T0 + 2 + 500]);
    expect(r.finalInventory).toEqual(new Map([[100, 5], [200, 7], [300, 9]]));
  });

  it('delivers poll-mode lines at the 250 ms watcher boundary', async () => {
    const r = await replay({source: linesOf(dump), mode: 'poll'});
    // Lines at +1/+2 ms reach the engine with the +250 ms poll.
    expect(at(r.events, 'init_complete')).toEqual([T0 + 250 + 500]);
  });

  it('applies operator controls at their timestamps', async () => {
    const r = await replay({
      source:   linesOf(dump),
      mode:     'exact',
      controls: [{at: T0 - 1, op: 'start'}, {at: T0 + 5_000, op: 'pause'}, {at: T0 + 6_000, op: 'resume'}],
    });
    const status = r.events.filter(e => e.event.type === 'session_status');
    expect(status.map(e => [e.at - T0, (e.event as {status: string}).status])).toEqual([[5_000, 'paused'], [6_000, 'running']]);
  });

  it('leaves real timers alone once finished', async () => {
    const before = Date.now();
    await replay({source: linesOf(dump)});
    expect(Math.abs(Date.now() - before)).toBeLessThan(60_000);
  });

  it('refuses to run on top of other fake timers instead of sharing the globals', async () => {
    vi.useFakeTimers();
    try {
      await expect(replay({source: linesOf(dump)})).rejects.toThrow(/twice/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('compareRows', () => {
  const stored = (over: Partial<StoredRow>): StoredRow => ({
    id: 1, mapIndex: 1, startedAt: T0, duration: 60_000, seasonalType: null, parentMapIndex: null, drops: {'100': 3}, ...over,
  });

  it('pairs a row whose start drifted but whose end matches', () => {
    const cmp = compareRows(
      [{kind: 'map', seasonalType: null, phase: null, overlap: false, startedAt: T0 + 16_000, endedAt: T0 + 60_000, drops: {'100': 3}}],
      [stored({})],
    );
    expect(cmp).toHaveLength(1);
    expect(cmp[0].stored?.id).toBe(1);
    expect(cmp[0].diffs).toEqual([]);
  });

  it('reports unpaired rows on both sides', () => {
    const cmp = compareRows(
      [{kind: 'seasonal', seasonalType: 'arcana', phase: null, overlap: false, startedAt: T0, endedAt: T0 + 1, drops: {}}],
      [stored({})],
    );
    expect(cmp.map(c => [c.replay !== null, c.stored !== null])).toEqual([[true, false], [false, true]]);
  });
});
