/**
 * Arcana (S9 "Tarot" / Fateful Contest) — minigame start, fight scene, finish.
 *
 * Timer starts at the Tarot Path minigame (`S9Taro Run`), continues into the
 * Fateful Contest fight scene (`SuMingTaLuo000`), and finishes when the player
 * leaves that scene. The fight scene lives under /Game/Art/Season/ but must NOT
 * spawn a generic map tracker — ArcanaHandler owns it (see classifyScene guard
 * in zone.ts).
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed, log, ARCANA_FIGHT, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Arcana integration', () => {
  it('s9_minigame starts the arcana tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);

    expect(ctx(e).registry.seasonal('arcana')).toBeDefined();
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
    expect(events.some(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'arcana')).toBe(true);
  });

  it('entering the Fateful Contest scene does NOT create a map tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);

    // Commit to the fight — scene transition into SuMingTaLuo000.
    feed(d, e, log.zoneTransition(TOWN, ARCANA_FIGHT));

    // The arcana tracker continues; no phantom map tracker on top of it.
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
    expect(ctx(e).registry.map).toBeNull();
    expect(events.some(ev => ev.type === 'map_started')).toBe(false);
  });

  it('s9_fight without a prior minigame still starts the tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Fight);

    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
  });

  it('leaving the Fateful Contest scene finishes the arcana tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(TOWN, ARCANA_FIGHT));

    // Fight over — return to town.
    feed(d, e, log.zoneTransition(ARCANA_FIGHT, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'arcana')).toBe(true);
  });

  it('drops inside the fight scene attribute to session and arcana, not a map tracker', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);

    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
    feed(d, e, log.s9Minigame);
    feed(d, e, log.zoneTransition(TOWN, ARCANA_FIGHT));

    feed(d, e, log.bagUpdate(1, 200, 4));

    expect(ctx(e).registry.session?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.seasonal('arcana')?.snapshot().drops[200]).toBe(4);
    expect(ctx(e).registry.map).toBeNull();
  });
});
