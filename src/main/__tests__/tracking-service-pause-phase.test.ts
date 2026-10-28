/**
 * TrackingService pause outside 'tracking': no-engine / initializing pauses
 * broadcast nothing and the session still credits its loot.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TrackingService, type TrackingDeps} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import {createEngine as createProductionEngine} from '@/main/engine/create-engine';
import type {RawEvent} from '@/worker/processors/types';
import type {EngineEvent} from '@/shared/contracts/engine';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {TOWN, MAP} from '@/main/engine/__tests__/seasonal-fixtures';

const NOW = new Date('2026-03-01T12:00:00Z').getTime();

function build() {
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  const sent: {channel: string; payload: unknown}[] = [];
  let onEvent: ((raw: RawEvent) => void) | null = null;
  const noop = vi.fn();
  const deps: TrackingDeps = {
    createEngine: emit => createProductionEngine(emit),
    store,
    broadcast: (channel, payload) => { sent.push({channel, payload}); },
    createWorker: cb => { onEvent = cb; return {start: vi.fn(), stop: vi.fn()}; },
    settings: {getAll: () => ({torchlightPath: 'C:/Games/TLI'})},
    filters:  {getAll: () => []},
    items: {
      getAll: () => [], getLocked: () => false, insertIfMissing: () => true,
      recordScrapedPrice: () => ({priceDate: NOW}),
    },
    wealthRecorder: {snapshot: noop},
    log: {debug: noop, info: noop, warn: noop, error: noop},
  };
  const service = new TrackingService(deps);
  const raw = (e: RawEvent) => { onEvent!(e); };
  const events = () => sent.filter(s => s.channel === 'engine:event').map(s => s.payload as EngineEvent);
  return {service, store, raw, events};
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('TrackingService pause outside tracking', () => {
  it('pause/resume before start (no engine) broadcast nothing and do not throw', () => {
    const h = build();
    expect(() => { h.service.pause(); h.service.resume(); }).not.toThrow();
    expect(h.events()).toEqual([]);
  });

  it('pause during initializing broadcasts no session_status; loot is credited and saved', () => {
    const h = build();
    h.service.start();
    h.service.pause();
    h.service.pause();
    h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
    h.raw({type: 'bag_snapshot_start'});
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 3});
    vi.advanceTimersByTime(30_000);
    h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
    h.service.stop();

    expect(h.events().filter(e => e.type === 'session_status')).toEqual([]);
    const saved = [...new Set(h.events().flatMap(e => (e.type === 'session_saved' ? [e.sessionId] : [])))];
    expect(saved).toHaveLength(1);   // one session, announced per write
    const s = h.store.getSession(saved[0])!;
    expect(s.drops['200']).toBe(3);
    expect(s.totalTime).toBeGreaterThanOrEqual(30);
  });

  it('continueSession paused during init keeps loaded drops and credits new loot', () => {
    const h = build();
    h.store.insertSession({
      id: 'old', name: 'My run', savedAt: '2026-02-01T10:00:00.000Z', totalTime: 120, mapTime: 100,
      mapCount: 2, drops: {'300': 4}, dropsBySource: {}, attribution: 'drop-through', priceSnapshot: {}, spent: {}, endedAt: Date.parse('2026-02-01T10:00:00.000Z'),
    });
    h.service.continueSession('old');
    h.service.pause();
    h.raw({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
    h.raw({type: 'bag_snapshot_start'});
    h.raw({type: 'zone_transition', fromScene: TOWN, toScene: MAP});
    h.raw({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 3});
    vi.advanceTimersByTime(20_000);
    h.raw({type: 'zone_transition', fromScene: MAP, toScene: TOWN});
    h.service.stop();

    expect(h.events().filter(e => e.type === 'session_status')).toEqual([]);
    const s = h.store.getSession('old')!;
    expect(s.drops['300']).toBe(4);
    expect(s.drops['200']).toBe(3);
    expect(s.totalTime).toBeGreaterThanOrEqual(140);
  });
});
