/**
 * `unit_finished` is persistence-only: TrackingService feeds it to
 * SessionPersistence but never broadcasts it, yet every other event still goes out.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type LogWorker} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import {engineEvents, type Sent} from '@/test/broadcast';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {TOWN, MAP, SANDLORD_HUB} from '@/main/engine/__tests__/seasonal-fixtures';
import {fakeWealthRecorder, fakeWealthSeries} from '@/test/wealth';

const NOW = new Date('2026-03-01T12:00:00Z').getTime();

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

function build() {
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: Sent[] = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const log = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
  const service = new TrackingService({
    createEngine:   emit => createProductionEngine(emit),
    store,
    broadcast:      (channel, payload) => { sent.push({channel, payload}); },
    createWorker:   cb => { onEvent = cb; return {start: vi.fn(), stop: vi.fn()} satisfies LogWorker; },
    settings:       {getAll: () => ({torchlightPath: 'C:/Games/TLI'})},
    filters:        {getAll: () => []},
    items:          {getAll: () => [], getLocked: () => false, insertIfMissing: () => true, recordScrapedPrice: () => ({priceDate: NOW})},
    wealthRecorder: fakeWealthRecorder(),
    wealthSeries:   fakeWealthSeries(),
    log,
  });
  const raw = (e: RawEvent) => onEvent!(e);
  const events = () => engineEvents(sent);
  return {service, store, raw, events, sent};
}

describe('TrackingService does not broadcast unit_finished', () => {
  it('a map with a hub child and a standalone hub run: rows saved, no unit on any channel', () => {
    const h = build();
    h.service.start();
    h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
    h.raw({type: 'bag_snapshot_start'});

    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: SANDLORD_HUB});        // standalone hub run
    vi.advanceTimersByTime(10_000);
    h.raw({type: 'zone_transition', fromScene: SANDLORD_HUB, toScene: TOWN});
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});                 // map with a hub child
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 3});
    vi.advanceTimersByTime(10_000);
    h.raw({type: 'zone_transition', fromScene: MAP, toScene: SANDLORD_HUB});
    vi.advanceTimersByTime(10_000);
    h.raw({type: 'zone_transition', fromScene: SANDLORD_HUB, toScene: TOWN});
    vi.advanceTimersByTime(31_000);
    h.service.stop();

    expect(h.events().some(e => (e.type as string) === 'unit_finished')).toBe(false);
    const types = h.events().map(e => e.type);
    expect(types).toContain('tracker_finished');
    const finished = h.events().flatMap(e => (e.type === 'tracker_finished' ? [e.tracker.kind] : []));
    expect(finished).toEqual(expect.arrayContaining(['seasonal', 'map', 'session']));

    const saves = h.events().flatMap(e => (e.type === 'session_saved' ? [e.sessionId] : []));
    const savedId = saves[0];
    // insert + 2 units (standalone hub run, map with its hub child) + final.
    expect(saves).toEqual([savedId, savedId, savedId, savedId]);
    const rows = h.store.getRows(savedId);
    expect(rows.map(r => [r.mapIndex, r.parentMapIndex, r.seasonalType])).toEqual([
      [1, null, 'sandlord'],
      [2, null, null],
      [2, 2, 'sandlord'],
    ]);
  });
});
