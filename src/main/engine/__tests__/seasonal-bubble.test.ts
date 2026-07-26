/**
 * Bubble exclusivity (Sandlord vs every non-bubble seasonal).
 *
 * - Starting Sandlord (ownsBubble=true) must finish any concurrent non-bubble
 *   seasonals first; their drops persist as overlap rows under whatever map
 *   was the parent at that moment.
 * - Non-bubble seasonals trying to start while a bubble is active must
 *   silently no-op (defensive — shouldn't physically happen, but log replay
 *   could reach the engine in odd states).
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, SANDLORD_HUB, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Bubble exclusivity', () => {
  it('starting Sandlord finishes any concurrent non-bubble seasonals first', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 9100, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s12Entry); // Overrealm in a regular map

    expect(ctx(e).registry.seasonal('overrealm')).toBeDefined();

    // Now enter Sandlord hub — bubble seasonal evicts overrealm.
    feed(d, e, log.zoneTransition(MAP, SANDLORD_HUB));

    expect(ctx(e).registry.seasonalsSize()).toBe(1);
    expect(ctx(e).registry.seasonal('sandlord')?.ownsBubble).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'overrealm')).toBe(true);

    // Subsequent drops attribute to sandlord, not overrealm.
    feed(d, e, log.bagUpdate(1, 9100, 5));
    const snap = ctx(e).registry.session!.snapshot();
    expect(snap.dropsBySource?.sandlord?.[9100]).toBe(5);
    expect(snap.dropsBySource?.overrealm?.[9100]).toBeUndefined();

    // Sandlord is own-area: the map→hub transition froze the map, so hub loot
    // does NOT drop through to it.
    expect(ctx(e).registry.map?.active).toBe(false);
    expect(ctx(e).registry.map?.snapshot().drops[9100]).toBeUndefined();
    expect(snap.dropsBySource?.map?.[9100]).toBeUndefined();
  });

  it('non-bubble seasonal start while a bubble is active is silently ignored', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 9200, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, SANDLORD_HUB));

    expect(ctx(e).registry.seasonal('sandlord')).toBeDefined();

    // Defensive log-replay — s14_strum during Sandlord shouldn't physically
    // happen (no S14 statues in Sandlord hub) but the engine must handle it.
    feed(d, e, log.s14Strum);

    expect(ctx(e).registry.seasonalsSize()).toBe(1);
    expect(!!ctx(e).registry.seasonal('lunaria')).toBe(false);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'lunaria')).toBe(false);
  });
});
