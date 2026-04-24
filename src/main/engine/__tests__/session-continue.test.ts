/**
 * Integration test: save a running session, then continue it in a fresh engine
 * and verify the tracker_started event carries the restored drops and elapsed
 * time so the renderer sees the correct FE and FE/hour immediately.
 *
 * Mirrors the real save→quit→reopen→continue flow:
 *   1. Run a session, accumulate drops + elapsed, hit stop.
 *   2. Capture the tracker_finished snapshot (what autoSaveSession persists).
 *   3. Build a LoadedSessionData from that snapshot (what startEngine does).
 *   4. Boot a fresh engine with that loaded data.
 *   5. Inspect the tracker_started event fired on init.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Engine}          from '@/main/engine/engine';
import {BagInitHandler}  from '@/main/engine/handlers/bag-init';
import {ZoneHandler}     from '@/main/engine/handlers/zone';
import {ItemHandler}     from '@/main/engine/handlers/item';
import type {EngineEvent} from '@/main/engine/types';

const TOWN_SCENE = 'XZ_YuJinZhiXiBiNanSuo200';
const MAP_SCENE  = '/Game/Art/Maps/S5_Boss';

function createEngine(events: EngineEvent[]): Engine {
  return new Engine((e) => events.push(e))
    .register(new BagInitHandler())
    .register(new ZoneHandler())
    .register(new ItemHandler());
}

describe('session-continue — save → restart → restore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('restored tracker_started carries prior drops and elapsed', () => {
    // ---------- Run 1: fresh session, accumulate drops + time ----------
    const run1Events: EngineEvent[] = [];
    const engine1 = createEngine(run1Events);
    engine1.start();

    // Initial bag: item 100 x 2
    engine1.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 2});
    vi.advanceTimersByTime(600);

    // Enter a map and pick up some drops
    engine1.onRawEvent({type: 'zone_transition', fromScene: TOWN_SCENE, toScene: MAP_SCENE});
    engine1.onRawEvent({type: 'bag_update', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
    engine1.onRawEvent({type: 'bag_update', pageId: 0, slotId: 2, itemId: 200, quantity: 10});

    // Advance wall-clock so session elapsed grows
    vi.advanceTimersByTime(60_000); // 1 minute

    // Exit map back to town
    engine1.onRawEvent({type: 'zone_transition', fromScene: MAP_SCENE, toScene: TOWN_SCENE});

    vi.advanceTimersByTime(30_000); // another 30s in town

    // Stop — captures tracker_finished with the final snapshot
    engine1.stop();

    const finished = run1Events.find(e => e.type === 'tracker_finished' && e.tracker.kind === 'session');
    expect(finished).toBeDefined();
    if (finished?.type !== 'tracker_finished') throw new Error('unreachable');

    const priorDrops   = finished.tracker.drops;
    const priorElapsed = finished.tracker.elapsed;
    const priorMeta    = finished.sessionMeta;

    // Sanity: session saw the drops and some elapsed time
    expect(priorDrops[100]).toBe(3); // 2 → 5 = +3
    expect(priorDrops[200]).toBe(10);
    expect(priorElapsed).toBeGreaterThanOrEqual(90_000); // 60s map + 30s town
    expect(priorMeta).toBeDefined();

    // ---------- Simulate autoSaveSession: ms → seconds round-trip ----------
    const dbTotalTime = priorElapsed / 1000; // exactly what engine.ts:90 does
    const dbMapTime   = (priorMeta?.mapTime ?? 0) / 1000;
    const dbMapCount  = priorMeta?.mapCount ?? 0;
    const dbDrops: Record<string, number> = {};
    for (const [k, v] of Object.entries(priorDrops)) dbDrops[String(k)] = v;

    // ---------- Run 2: fresh engine, continue saved session ----------
    const run2Events: EngineEvent[] = [];
    const engine2 = createEngine(run2Events);
    engine2.loadSession({
      id:        'session-1',
      name:      'Saved',
      drops:     dbDrops,
      totalTime: dbTotalTime, // seconds — engine converts to ms
      mapTime:   dbMapTime,
      mapCount:  dbMapCount,
    });
    engine2.start();

    engine2.onRawEvent({type: 'bag_init', pageId: 0, slotId: 1, itemId: 100, quantity: 5});
    engine2.onRawEvent({type: 'bag_init', pageId: 0, slotId: 2, itemId: 200, quantity: 10});
    vi.advanceTimersByTime(600);

    // ---------- Inspect tracker_started emitted on continue ----------
    const started = run2Events.find(e => e.type === 'tracker_started' && e.tracker.kind === 'session');
    expect(started).toBeDefined();
    if (started?.type !== 'tracker_started') throw new Error('unreachable');

    // THE CORE ASSERTIONS — what the renderer receives on continue:
    expect(started.tracker.drops[100]).toBe(3);
    expect(started.tracker.drops[200]).toBe(10);
    expect(started.tracker.elapsed).toBeGreaterThanOrEqual(priorElapsed);
    expect(started.sessionMeta?.mapCount).toBe(priorMeta?.mapCount);
  });
});
