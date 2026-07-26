/**
 * Dream (S5) — level_type transitions.
 *
 * Stack under test: log line → Dispatcher → Engine.onRawEvent → DreamHandler
 * → ctx.seasonals + emitted EngineEvents.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Dream integration', () => {
  it('level_type 3→11 starts dream tracker, 11→3 finishes it', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Enter Dream
    feed(d, e, log.levelType(11));
    expect(ctx(e).registry.seasonal('dream')).toBeDefined();
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'dream')).toBe(true);

    // Drop inside Dream reaches seasonal tracker
    feed(d, e, log.bagUpdate(1, 100, 5));
    expect(ctx(e).registry.seasonal('dream')?.snapshot().drops[100]).toBe(5);

    // Exit Dream
    feed(d, e, log.levelType(3));
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'dream')).toBe(true);
  });

  it('drops inside Dream credit dream AND the map — dream is in-map', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.levelType(11));

    feed(d, e, log.bagUpdate(1, 100, 3));

    expect(ctx(e).registry.session?.snapshot().drops[100]).toBe(3);
    expect(ctx(e).registry.map?.snapshot().drops[100]).toBe(3); // drops through
    expect(ctx(e).registry.seasonal('dream')?.snapshot().drops[100]).toBe(3);
  });
});
