/**
 * Tests for WealthRecorder: a snapshot values the whole bag GROSS (no filter,
 * no tax) and hands one row to the injected insert. Item prices, insert and
 * logger are faked; the engine is a fake inventory, or a real engine where
 * the filter itself is under test.
 */
import {describe, it, expect, beforeEach, afterEach, vi, type Mock} from 'vitest';
import {WealthRecorder} from '@/main/wealth-recorder';
import {createEngine} from '@/main/engine/create-engine';
import type {DbItem, DbWealthDatapoint} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
import {TEST_IDENTITY, TOWN, MAP} from '@/main/engine/__tests__/seasonal-fixtures';

const NOW = new Date('2026-03-01T12:00:00Z').getTime();

interface Harness {
  recorder: WealthRecorder;
  inserted: DbWealthDatapoint[];
  log:      {debug: Mock};
}

function build(items: DbItem[]): Harness {
  const inserted: DbWealthDatapoint[] = [];
  const log = {debug: vi.fn()};
  const recorder = new WealthRecorder({items: {getAll: () => items}, insert: p => { inserted.push(p); }, log});
  return {recorder, inserted, log};
}

const item = (id: string, price: number, type = 'other'): DbItem => ({id, name: `Item ${id}`, type, price, priceDate: 0});

const inventory = (entries: Array<[number, number]>) => ({getInventory: () => new Map(entries)});

const breakdownOf = (point: DbWealthDatapoint) =>
  JSON.parse(point.breakdown) as Record<string, {qty: number; price: number; total: number}>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WealthRecorder', () => {
  it('values every bag item gross: breakdown per string id, value = Σ totals', () => {
    const h = build([item('100', 2.5), item('200', 0.25, 'equipment')]);
    h.recorder.snapshot(inventory([[100, 4], [200, 8]]), 'sess-1');

    expect(h.inserted).toHaveLength(1);
    const [point] = h.inserted;
    expect(point).toMatchObject({timestamp: NOW, value: 12, sessionId: 'sess-1'});
    const breakdown = breakdownOf(point);
    expect(breakdown).toEqual({
      '100': {qty: 4, price: 2.5,  total: 10},
      '200': {qty: 8, price: 0.25, total: 2},
    });
    expect(Object.keys(breakdown)).toEqual(['100', '200']);
    expect(point.value).toBe(Object.values(breakdown).reduce((s, e) => s + e.total, 0));
    expect(h.log.debug).toHaveBeenCalledWith('wealth', 'Wealth snapshot: value=12, items=2');
  });

  it('skips non-positive quantities', () => {
    const h = build([item('100', 3), item('200', 5), item('300', 7)]);
    h.recorder.snapshot(inventory([[100, 0], [200, -2], [300, 1]]), 'sess-1');

    expect(breakdownOf(h.inserted[0])).toEqual({'300': {qty: 1, price: 7, total: 7}});
    expect(h.inserted[0].value).toBe(7);
  });

  it('an item with no known price is kept at 0', () => {
    const h = build([item('100', 3)]);
    h.recorder.snapshot(inventory([[100, 2], [999, 5]]), 'sess-1');

    expect(breakdownOf(h.inserted[0])).toEqual({
      '100': {qty: 2, price: 3, total: 6},
      '999': {qty: 5, price: 0, total: 0},
    });
    expect(h.inserted[0].value).toBe(6);
  });

  it('passes the session id through, null included', () => {
    const h = build([item('100', 1)]);
    h.recorder.snapshot(inventory([[100, 1]]), null);
    h.recorder.snapshot(inventory([[100, 1]]), 'sess-2');

    expect(h.inserted.map(p => p.sessionId)).toEqual([null, 'sess-2']);
  });

  it('an empty bag records a zero point', () => {
    const h = build([item('100', 1)]);
    h.recorder.snapshot(inventory([]), 'sess-1');

    expect(h.inserted).toEqual([{timestamp: NOW, value: 0, sessionId: 'sess-1', breakdown: '{}'}]);
  });

  it('an engine filter hiding an item in every scope (wealth included) does not hide it here', () => {
    const events: EngineEvent[] = [];
    const engine = createEngine(e => { events.push(e); });
    engine.start(TEST_IDENTITY);
    engine.setItemTypes([['200', 'equipment']]);
    engine.setFilterRules([{
      id: 'r1', action: 'hide', scopes: ['session', 'map', 'wealth'], kind: {type: 'by-type', itemType: 'equipment'},
    }]);
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 4});
    engine.onRawEvent({type: 'bag_init', pageId: 0, slotId: 2, itemId: 200, quantity: 6});
    engine.onRawEvent({type: 'bag_snapshot_start'});
    engine.onRawEvent({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
    engine.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 8}); // +2, hidden
    expect(events.filter(e => e.type === 'drop')).toEqual([]); // the filter is live

    const h = build([item('100', 2.5), item('200', 0.25, 'equipment')]);
    h.recorder.snapshot(engine, 'sess-1');

    expect(breakdownOf(h.inserted[0])).toEqual({
      '100': {qty: 4, price: 2.5,  total: 10},
      '200': {qty: 8, price: 0.25, total: 2},
    });
    expect(h.inserted[0].value).toBe(12);
  });
});
