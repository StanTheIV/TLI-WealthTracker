/**
 * Vorex (S13) — window open/close/abandon.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN, VOREX_REWARD} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Vorex integration', () => {
  it('s13_start starts vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    expect(ctx(e).registry.seasonal('vorex')).toBeDefined();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('s13_window_close pauses the vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    feed(d, e, log.s13WindowClose);

    expect(ctx(e).registry.seasonal('vorex')).toBeDefined();
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(false); // paused
    expect(events.some(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('second s13_start after window_close resumes the vorex tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13WindowClose);

    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(false);

    feed(d, e, log.s13Start); // reopen
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(true);
  });

  it('s13_abandon → zone to reward zone completes Vorex, tracker stays alive', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13Abandon);

    // Zone to reward zone = completed
    feed(d, e, log.zoneTransition(MAP, VOREX_REWARD));

    expect(ctx(e).registry.seasonal('vorex')).toBeDefined(); // still alive for loot
    expect(ctx(e).registry.seasonal('vorex')?.active).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_finished')).toBe(false); // not finished yet
  });

  it('s13_abandon → zone to non-reward zone abandons Vorex, tracker finishes', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);
    feed(d, e, log.s13Abandon);

    // Zone to some other area = abandoned
    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'vorex')).toBe(true);
  });

  it('drops inside Vorex reach session, map and vorex trackers', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s13Start);

    feed(d, e, log.bagUpdate(1, 200, 4));

    expect(ctx(e).registry.session?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.map?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.seasonal('vorex')?.snapshot().drops[200]).toBe(4);
  });
});
