/**
 * Single-owner attribution across concurrent in-map seasonals.
 *
 * Drop-through means every live tier accrues a drop, but `dropsBySource` must
 * name exactly ONE owner: the most recently ACTIVATED live seasonal. These
 * tests drive Afterlight and the Sandlord coin tile against each other — the
 * two newest in-map mechanics, and the pair most likely to overlap in practice
 * since both fire from ordinary map content.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Afterlight + Sandlord tile — only the newest trigger owns drops', () => {
  it('ownership passes to whichever mechanic triggered last', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Afterlight first — the only active seasonal, so it owns.
    feed(d, e, log.afterlightStart);
    feed(d, e, log.bagUpdate(1, 9000, 1));   // +1 → afterlight

    // The coin tile activates while the warden fight is still live. Both
    // trackers are now active, but the tile triggered last.
    feed(d, e, log.s10Wave);
    feed(d, e, log.bagUpdate(1, 9000, 4));   // +3 → sandlord

    // A fresh mob-landing wave re-triggers the tile — it stays newest.
    feed(d, e, log.s10Land);
    feed(d, e, log.bagUpdate(1, 9000, 6));   // +2 → sandlord

    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.afterlight?.[9000]).toBe(1);
    expect(dbs.sandlord?.[9000]).toBe(5);

    // Single-owner: the two slices account for every drop, no double-count.
    expect(dbs.afterlight![9000] + dbs.sandlord![9000]).toBe(6);
    expect(ctx(e).registry.session!.snapshot().drops[9000]).toBe(6);
  });

  it('each tracker accrues only what it owned, while the map accrues everything', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.afterlightStart);
    feed(d, e, log.bagUpdate(1, 9000, 2));   // +2 → afterlight
    feed(d, e, log.s10Wave);
    feed(d, e, log.bagUpdate(1, 9000, 5));   // +3 → sandlord

    expect(ctx(e).registry.seasonal('afterlight')?.snapshot().drops[9000]).toBe(2);
    expect(ctx(e).registry.seasonal('sandlord')?.snapshot().drops[9000]).toBe(3);
    // Both are in-map, so the map never paused and is a superset of both.
    expect(ctx(e).registry.map?.snapshot().drops[9000]).toBe(5);
  });

  it('ownership falls back to the other seasonal when the newest goes dormant', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.afterlightStart);
    feed(d, e, log.s10Wave);                 // tile is newest → owns
    feed(d, e, log.bagUpdate(1, 9000, 1));   // +1 → sandlord

    // The tile's wave window expires while Afterlight's is kept alive by its own
    // waves. Sandlord pauses rather than finishing (pauseOnLootExpiry), so it
    // stays in the registry but inactive — ownership falls to Afterlight.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(3_400);
      feed(d, e, log.afterlightWave);
    }
    expect(ctx(e).registry.seasonal('sandlord')?.active).toBe(false);
    expect(ctx(e).registry.seasonal('afterlight')?.active).toBe(true);

    feed(d, e, log.bagUpdate(1, 9000, 3));   // +2 → afterlight

    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.sandlord?.[9000]).toBe(1);
    expect(dbs.afterlight?.[9000]).toBe(2);
  });

  it('a dormant tile re-triggered by a late wave takes ownership back', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Tile first, then Afterlight — Afterlight is newest and owns.
    feed(d, e, log.s10Wave);
    vi.advanceTimersByTime(10_100);          // tile goes dormant
    feed(d, e, log.afterlightStart);
    feed(d, e, log.bagUpdate(1, 9000, 1));   // +1 → afterlight

    // A late wave resumes the tile. Despite being created FIRST it is now the
    // most recently activated, so it must take ownership back — recency of
    // activation, not of creation.
    feed(d, e, log.s10Land);
    feed(d, e, log.bagUpdate(1, 9000, 4));   // +3 → sandlord

    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.afterlight?.[9000]).toBe(1);
    expect(dbs.sandlord?.[9000]).toBe(3);
  });

  // The rule: whichever seasonal armed or re-armed its window most recently owns
  // the drops. The three cases below are the ones that have no dormant→active
  // transition to hang the bump on, so arming itself has to move ownership.

  it('a wave on a STILL-ACTIVE seasonal takes ownership back', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.afterlightStart);
    feed(d, e, log.s10Wave);                 // tile is newest → owns
    feed(d, e, log.bagUpdate(1, 9000, 1));   // +1 → sandlord

    // The player goes back to the Afterlight fight. Its tracker never went
    // dormant, so there is no resume to hang the bump on.
    vi.advanceTimersByTime(1_100);
    feed(d, e, log.afterlightWave);
    feed(d, e, log.bagUpdate(1, 9000, 4));   // +3 → afterlight

    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.sandlord?.[9000]).toBe(1);
    expect(dbs.afterlight?.[9000]).toBe(3);
  });

  it('a strum on a still-active Lunaria takes ownership back', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.s14Strum);
    feed(d, e, log.s10Wave);                 // tile newest → owns
    feed(d, e, log.bagUpdate(1, 9000, 1));   // +1 → sandlord

    feed(d, e, log.s14Strum);                // re-engage, no dormancy in between
    feed(d, e, log.bagUpdate(1, 9000, 4));   // +3 → lunaria

    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.sandlord?.[9000]).toBe(1);
    expect(dbs.lunaria?.[9000]).toBe(3);
  });

  it('the mechanic that just ENDED owns its own loot window', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.afterlightStart);
    feed(d, e, log.s10Wave);                 // tile newest → owns
    feed(d, e, log.bagUpdate(1, 9000, 1));   // +1 → sandlord

    // The warden dies right in front of the player — the chest it drops must
    // credit Afterlight, not whatever happened to be triggered later.
    feed(d, e, log.afterlightEnd);
    feed(d, e, log.bagUpdate(1, 9000, 4));   // +3 → afterlight

    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.sandlord?.[9000]).toBe(1);
    expect(dbs.afterlight?.[9000]).toBe(3);
  });

  it('the warden kill keeps Afterlight owning through its loot window', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.s10Wave);
    feed(d, e, log.afterlightStart);         // afterlight newest
    feed(d, e, log.afterlightEnd);           // kill → loot window, still active

    feed(d, e, log.bagUpdate(1, 9000, 2));   // +2 → afterlight (window open)

    // Window expires → afterlight finishes outright (pauseOnLootExpiry false),
    // leaving the still-active tile as the only owner.
    vi.advanceTimersByTime(5_100);
    expect(ctx(e).registry.seasonal('afterlight')).toBeNull();

    feed(d, e, log.bagUpdate(1, 9000, 3));   // +1 → sandlord

    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    expect(dbs.afterlight?.[9000]).toBe(2);
    expect(dbs.sandlord?.[9000]).toBe(1);
  });

  it('there is only ever one tracker per seasonal type', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Repeat triggers of both mechanics, interleaved and spanning a dormancy —
    // the registry keys seasonals by type, so each folds into its existing
    // tracker instead of standing up a rival one.
    feed(d, e, log.afterlightStart);
    feed(d, e, log.s10Wave);
    feed(d, e, log.afterlightStart);
    feed(d, e, log.s10Land);
    feed(d, e, log.bagUpdate(1, 9000, 2));
    vi.advanceTimersByTime(10_100);          // tile lapses into dormancy
    feed(d, e, log.s10Wave);                 // and is revived, not replaced
    feed(d, e, log.bagUpdate(1, 9000, 5));
    feed(d, e, log.afterlightEnd);
    feed(d, e, log.afterlightStart);

    const started = (t: string) => events.filter(
      ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === t,
    ).length;
    expect(started('afterlight')).toBe(1);
    expect(started('sandlord')).toBe(1);
    expect(ctx(e).registry.seasonalsSize()).toBe(2);

    // Every drop landed on one of those two trackers — had a rival been stood
    // up it would show as a third slice, or as qty missing from these.
    const dbs = ctx(e).registry.session!.snapshot().dropsBySource!;
    const owned = (dbs.afterlight?.[9000] ?? 0) + (dbs.sandlord?.[9000] ?? 0);
    expect(owned).toBe(ctx(e).registry.session!.snapshot().drops[9000]);
    expect(owned).toBe(5);
  });

  it('drops never double-count: per-source slices sum to session FE', () => {
    const d = createDispatcher();
    const e = createEngine([]);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    feed(d, e, log.afterlightStart);
    feed(d, e, log.bagUpdate(1, 9000, 2));
    feed(d, e, log.s10Wave);
    feed(d, e, log.bagUpdate(1, 9000, 5));
    feed(d, e, log.s10Land);
    feed(d, e, log.bagUpdate(1, 9000, 7));
    feed(d, e, log.afterlightEnd);
    vi.advanceTimersByTime(10_100);          // both windows lapse
    feed(d, e, log.bagUpdate(1, 9000, 9));   // no active seasonal → map owns

    const snap = ctx(e).registry.session!.snapshot();
    const dbs  = snap.dropsBySource!;
    const total = (dbs.afterlight?.[9000] ?? 0)
                + (dbs.sandlord?.[9000]   ?? 0)
                + (dbs.map?.[9000]        ?? 0);

    expect(total).toBe(snap.drops[9000]);
    expect(snap.drops[9000]).toBe(9);
  });

  it('the owner flag marks exactly one seasonal and follows the last re-arm', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 9000, quantity: 0}]);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    // Replays the flag the way the renderer does: last value published per type.
    const flagged = () => {
      const m = new Map<string, boolean>();
      for (const ev of events) {
        if ((ev.type === 'tracker_started' || ev.type === 'tracker_update') && ev.tracker.seasonalType) {
          m.set(ev.tracker.seasonalType, ev.tracker.owner === true);
        }
        if (ev.type === 'tracker_finished' && ev.tracker.seasonalType) m.delete(ev.tracker.seasonalType);
      }
      return [...m].filter(([, owner]) => owner).map(([type]) => type);
    };

    feed(d, e, log.afterlightStart);
    expect(flagged()).toEqual(['afterlight']);

    feed(d, e, log.s10Wave);
    expect(flagged()).toEqual(['sandlord']);

    vi.advanceTimersByTime(1_100);
    feed(d, e, log.afterlightWave);
    expect(flagged()).toEqual(['afterlight']);
  });
});
