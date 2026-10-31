/**
 * getState() reads the seq BEFORE the replay: an `error` envelope stamped by a throwing replay is not
 * in the snapshot, so it gets a seq above it and reaches the window (which applies seq > snapshot.seq).
 */
import {describe, it, expect, vi} from 'vitest';

vi.mock('@/main/logger', () => ({log: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}}));

import {TrackingService, type LogWorker} from '@/main/tracking-service';
import {SqliteSessionStore} from '@/main/db/session-store';
import {Engine} from '@/main/engine/engine';
import {BagInitHandler} from '@/main/engine/handlers/bag-init';
import {engineEnvelopes, type Sent} from '@/test/broadcast';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {fakeWealthRecorder, fakeWealthSeries} from '@/test/wealth';

describe('getState() with a throwing replay hook', () => {
  it('the error envelope gets a seq above the snapshot seq (the snapshot does not contain it)', () => {
    const sent: Sent[] = [];
    const service = new TrackingService({
      createEngine: emit => {
        return new Engine(emit).register(new BagInitHandler()).register({name: 'A', handles: [], handle: () => undefined, replay: () => { throw new Error('replay boom'); }});
      },
      store:          new SqliteSessionStore(openMigratedNodeSqlite()),
      broadcast:      (channel, payload) => { sent.push({channel, payload}); },
      createWorker:   () => ({start: () => undefined, stop: () => undefined}) satisfies LogWorker,
      settings:       {getAll: () => ({})},
      filters:        {getAll: () => []},
      items:          {getAll: () => [], getLocked: () => false, recordScrapedPrice: () => ({priceDate: 0}), insertIfMissing: () => true},
      wealthRecorder: fakeWealthRecorder(),
      wealthSeries:   fakeWealthSeries(),
      log:            {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    });
    service.start();

    const snapshot = service.getState();
    const errorEnvelope = engineEnvelopes(sent).find(e => e.event.type === 'error');
    expect(errorEnvelope).toBeDefined();
    expect(snapshot.events.some(e => e.type === 'error')).toBe(false);
    // A window applies the snapshot, then only envelopes with seq > snapshot.seq: the error must still reach it.
    expect(errorEnvelope!.seq).toBeGreaterThan(snapshot.seq);
  });
});
