/**
 * Concurrent seasonals — Lunaria-during-Overrealm in a Netherrealm map.
 *
 * Load-bearing test for the multi-seasonal refactor: verifies the writer rule
 * attributes each drop to exactly one source, with Lunaria pause/resume
 * transferring writer status correctly to the next-newest active seasonal.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Concurrent seasonals (Overrealm + Lunaria)', () => {
  it('writer attribution + per-tracker FE divergence over a full Netherrealm map', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP)); // map starts; map is writer

    // Overrealm starts → newest active = overrealm.
    feed(d, e, log.s12Entry);
    feed(d, e, log.bagUpdate(1, 9000, 1)); // drop A: +1 → overrealm

    // Lunaria strums in → newest active = lunaria.
    feed(d, e, log.s14Strum);
    feed(d, e, log.bagUpdate(1, 9000, 3)); // drop B: +2 → lunaria
    feed(d, e, log.bagUpdate(1, 9000, 5)); // drop C: +2 → lunaria

    // Lunaria timer expires → lunaria pauses → newest active falls back to overrealm.
    vi.advanceTimersByTime(5_100);
    feed(d, e, log.bagUpdate(1, 9000, 6)); // drop D: +1 → overrealm (lunaria paused)

    // Overrealm exits → loot window armed; overrealm tracker still active.
    feed(d, e, log.s12Exit);
    feed(d, e, log.bagUpdate(1, 9000, 7)); // drop E: +1 → overrealm (loot window)

    // Overrealm loot timer expires → overrealm finishes; only lunaria (paused)
    // remains. With no active seasonal, writer falls through to 'map'.
    vi.advanceTimersByTime(5_100);
    feed(d, e, log.bagUpdate(1, 9000, 9)); // drop F: +2 → map (only paused-lunaria remains)

    // Town entry — ZoneHandler finishes the (paused) lunaria tracker.
    feed(d, e, log.zoneTransition(MAP, TOWN));

    // Both seasonals gone, map gone, session has the totals + per-source breakdown.
    expect(ctx(e).seasonals.size).toBe(0);
    expect(ctx(e).map).toBeNull();

    const session = ctx(e).session!;
    const snap    = session.snapshot();

    // Total drops: every drop counted once into session._drops.
    expect(snap.drops[9000]).toBe(9);

    // Per-source attribution: each drop to exactly one source.
    expect(snap.dropsBySource).toBeDefined();
    expect(snap.dropsBySource!.overrealm?.[9000]).toBe(3); // A + D + E
    expect(snap.dropsBySource!.lunaria?.[9000]).toBe(4);   // B + C
    expect(snap.dropsBySource!.map?.[9000]).toBe(2);       // F

    // Slices sum to exactly session FE.
    const sourceTotal = (snap.dropsBySource!.overrealm?.[9000] ?? 0)
                      + (snap.dropsBySource!.lunaria?.[9000]   ?? 0)
                      + (snap.dropsBySource!.map?.[9000]       ?? 0);
    expect(sourceTotal).toBe(snap.drops[9000]);
  });

  it('Lunaria tracker finishes via ZoneHandler on town entry while paused', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 9001, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));
    feed(d, e, log.s14Strum);
    vi.advanceTimersByTime(5_100); // lunaria pauses

    expect(ctx(e).seasonals.get('lunaria')?.active).toBe(false);

    feed(d, e, log.zoneTransition(MAP, TOWN));

    expect(ctx(e).seasonals.size).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'lunaria')).toBe(true);
  });
});
