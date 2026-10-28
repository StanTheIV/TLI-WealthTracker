/**
 * Adversarial tests for gross wealth (step 1.7): a REAL TrackingService wired
 * with a REAL WealthRecorder and a real engine. Only the worker, broadcast,
 * items, settings, filters and logger are faked; the recorder's inserts are
 * captured. Contract: every wealth point is the gross, unfiltered, untaxed
 * value of the bag at that moment, while the filter still governs loot credit.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker} from '@/main/tracking-service';
import {WealthRecorder} from '@/main/wealth-recorder';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {DbItem, DbItemFilter, DbWealthDatapoint} from '@/shared/contracts/db';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {FilterRule} from '@/shared/item-filter';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {TOWN, MAP} from '@/main/engine/__tests__/seasonal-fixtures';

const TORCHLIGHT = 'C:/Games/Torchlight Infinite';
const NOW        = new Date('2026-03-01T12:00:00Z').getTime();

const PLAIN = 100; // slot 1, qty 5, price 1
const GEAR  = 150; // slot 2, qty 7, price 2, type equipment
const COIN  = 160; // slot 3, qty 1, price 0.5
const GHOST = 999; // slot 4, qty 3, no item row

interface Harness {
  service: TrackingService;
  store:   SqliteSessionStore;
  points:  DbWealthDatapoint[];
  items:   DbItem[];
  sent:    EngineEvent[];
  raw:     (e: RawEvent) => void;
}

const dbItem = (id: number, price: number, type = 'other'): DbItem =>
  ({id: String(id), name: `Item ${id}`, type, price, priceDate: 0});

function build(): Harness {
  const store  = new SqliteSessionStore(openMigratedNodeSqlite());
  const points: DbWealthDatapoint[] = [];
  const sent: EngineEvent[] = [];
  const items: DbItem[] = [dbItem(PLAIN, 1), dbItem(GEAR, 2, 'equipment'), dbItem(COIN, 0.5)];
  const filters: DbItemFilter[] = [];
  let onEvent: ((r: RawEvent) => void) | null = null;
  const worker = {start: vi.fn(), stop: vi.fn()};
  const log = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const itemsDep = {
    getAll:             () => items,
    getLocked:          () => false,
    insertIfMissing:    () => true,
    recordScrapedPrice: () => ({priceDate: NOW}),
  };
  const service = new TrackingService({
    createEngine:   emit => createEngine(emit),
    store,
    broadcast:      (channel, payload) => { if (channel === 'engine:event') sent.push(payload as EngineEvent); },
    createWorker:   cb => { onEvent = cb; return worker satisfies LogWorker; },
    settings:       {getAll: () => ({torchlightPath: TORCHLIGHT})},
    filters:        {getAll: () => filters},
    items:          itemsDep,
    wealthRecorder: new WealthRecorder({items: itemsDep, insert: p => { points.push(p); }, log}),
    log,
  });
  return {service, store, points, items, sent, raw: e => onEvent!(e)};
}

const bagInit = (h: Harness) => {
  h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: PLAIN, quantity: 5});
  h.raw({type: 'bag_init', pageId: 0, slotId: 2, itemId: GEAR,  quantity: 7});
  h.raw({type: 'bag_init', pageId: 0, slotId: 3, itemId: COIN,  quantity: 1});
  h.raw({type: 'bag_init', pageId: 0, slotId: 4, itemId: GHOST, quantity: 3});
  h.raw({type: 'bag_snapshot_start'});
};

/** Town → map, set the given slots to new TOTALS, map → town. */
const runMap = (h: Harness, totals: Array<[number, number, number]>) => {
  h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
  for (const [slotId, itemId, quantity] of totals) h.raw({type: 'bag_update', pageId: 0, slotId, itemId, quantity});
  vi.advanceTimersByTime(60_000);
  h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
};

const drops = (h: Harness) =>
  h.sent.flatMap(e => (e.type === 'drop' ? [e] : []));

const bd = (p: DbWealthDatapoint) =>
  JSON.parse(p.breakdown) as Record<string, {qty: number; price: number; total: number}>;

const qtys = (p: DbWealthDatapoint) =>
  Object.fromEntries(Object.entries(bd(p)).map(([k, v]) => [k, v.qty]));

const hide = (kind: FilterRule['kind'], id = 'r'): FilterRule =>
  ({id, action: 'hide', scopes: ['session', 'map', 'wealth'], kind});

const hideGearAndPlain = (): FilterRule[] => [
  hide({type: 'by-type', itemType: 'equipment'}, 'r1'),
  hide({type: 'by-item', itemId: String(PLAIN)}, 'r2'),
];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('adversarial - gross wealth through the real service', () => {
  it('filter hiding by type and by item: wealth points stay full, session drops exclude them', () => {
    const h = build();
    h.service.start();
    h.service.setFilterRules(hideGearAndPlain());
    h.service.setItemType(String(GEAR), 'equipment');
    bagInit(h);
    runMap(h, [[2, GEAR, 9], [1, PLAIN, 8], [3, COIN, 3]]); // +2 gear, +3 plain, +2 coin
    expect(h.points).toHaveLength(2);
    const sessionId = h.points[0].sessionId!;
    h.service.stop();

    expect(qtys(h.points[0])).toEqual({100: 5, 150: 7, 160: 1, 999: 3});
    expect(qtys(h.points[1])).toEqual({100: 8, 150: 9, 160: 3, 999: 3});
    expect(h.points[1].value).toBe(8 * 1 + 9 * 2 + 3 * 0.5);
    expect(h.store.getSession(sessionId)!.drops).toEqual({[COIN]: 2});
    expect(drops(h).map(d => d.itemId)).toEqual([COIN]);
  });

  it('filter changed, cleared and item type changed mid-session: wealth ignores it, loot follows it', () => {
    const h = build();
    h.service.start();
    h.service.setFilterRules(hideGearAndPlain());
    h.service.setItemType(String(GEAR), 'equipment');
    bagInit(h);

    runMap(h, [[2, GEAR, 8], [1, PLAIN, 6]]);         // map 1: both hidden
    h.service.setFilterRules(null);
    runMap(h, [[2, GEAR, 10], [1, PLAIN, 7]]);        // map 2: filter cleared, +2 gear +1 plain credited
    h.service.setFilterRules([hide({type: 'by-type', itemType: 'equipment'})]);
    h.service.setItemType(String(COIN), 'equipment'); // COIN becomes equipment
    runMap(h, [[3, COIN, 4], [2, GEAR, 11], [1, PLAIN, 9]]); // map 3: coin+gear hidden, +2 plain credited
    h.service.setItemType(String(GEAR), 'material');  // gear stops being equipment
    runMap(h, [[2, GEAR, 12]]);                       // map 4: gear credited again
    const sessionId = h.points[0].sessionId!;
    h.service.stop();

    expect(h.points.map(p => qtys(p))).toEqual([
      {100: 5, 150: 7,  160: 1, 999: 3},
      {100: 6, 150: 8,  160: 1, 999: 3},
      {100: 7, 150: 10, 160: 1, 999: 3},
      {100: 9, 150: 11, 160: 4, 999: 3},
      {100: 9, 150: 12, 160: 4, 999: 3},
    ]);
    expect(h.store.getSession(sessionId)!.drops).toEqual({[GEAR]: 3, [PLAIN]: 3});
  });

  it('prices are read at snapshot time; an unknown item stays at 0; later changes leave inserted points alone', () => {
    const h = build();
    h.service.start();
    bagInit(h);
    const first = structuredClone(h.points[0]);
    expect(bd(first)['999']).toEqual({qty: 3, price: 0, total: 0});
    expect(bd(first)['150'].price).toBe(2);

    h.items.find(i => i.id === String(GEAR))!.price = 5;
    h.items.push(dbItem(GHOST, 4));
    runMap(h, [[2, GEAR, 8]]);

    expect(h.points).toHaveLength(2);
    expect(h.points[0]).toEqual(first); // untouched by the later price + bag change
    expect(bd(h.points[1])['150']).toEqual({qty: 8, price: 5, total: 40});
    expect(bd(h.points[1])['999']).toEqual({qty: 3, price: 4, total: 12});
    expect(bd(h.points[1])['100'].price).toBe(1);
  });

  it('every point: value = Σ breakdown totals, string keys, valid JSON; one point per trigger', () => {
    const h = build();
    h.service.start();
    h.service.setFilterRules([hide({type: 'by-item', itemId: String(COIN)})]);
    bagInit(h);
    runMap(h, [[3, COIN, 6]]);
    runMap(h, [[3, COIN, 7]]);

    expect(h.points).toHaveLength(3); // init_complete + 2 x map_ended
    for (const p of h.points) {
      const b = bd(p);
      expect(Object.keys(b).every(k => /^\d+$/.test(k))).toBe(true);
      expect(p.value).toBeCloseTo(Object.values(b).reduce((s, e) => s + e.total, 0), 10);
      for (const e of Object.values(b)) expect(e.total).toBe(e.qty * e.price);
      expect(typeof p.timestamp).toBe('number');
    }
    expect(qtys(h.points[2])[COIN]).toBe(7);
    expect(h.sent.filter(e => e.type === 'wealth_recorded')).toHaveLength(3);
  });
});
