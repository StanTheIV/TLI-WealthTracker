/**
 * Tartarus (S16) — board minigame → Riot checkout → prison fight scene.
 * Sequences mirror real logs: every device open first replays the previous
 * settled board's checkout, which the player dismisses with Ignore.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TARTARUS_FIGHT, TOWN} from './seasonal-fixtures';

type Finished = Extract<EngineEvent, {type: 'tracker_finished'}>;

function tartarusFinished(events: EngineEvent[]): Finished[] {
  return events.filter((ev): ev is Finished =>
    ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'tartarus');
}

function tartarusStarted(events: EngineEvent[]): number {
  return events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'tartarus').length;
}

type Harness = {d: ReturnType<typeof createDispatcher>; e: ReturnType<typeof createEngine>; events: EngineEvent[]};

function setup(): Harness {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);
  return {d, e, events};
}

/** The settled-board replay every device open starts with, dismissed. */
function dismissSettledReplay({d, e}: Harness): void {
  feed(d, e, log.s16BoardOpenSettled);
  feed(d, e, log.s16Ignore);
  feed(d, e, log.s16BoardClose);
  feed(d, e, log.s16BoardCloseTip);
}

/** Suppress on the Riot screen, with the sibling lines the game logs. */
function suppress({d, e}: Harness): void {
  feed(d, e, log.s16SuppressRow);
  feed(d, e, log.s16Suppress);
  feed(d, e, log.s16BoardClose);
  feed(d, e, log.s16BoardCloseTip);
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('Tartarus integration', () => {
  it('town cycle: one run covering board + fight, no phantom map', () => {
    const h = setup();
    const {d, e, events} = h;

    dismissSettledReplay(h);
    expect(ctx(e).registry.seasonal('tartarus')).toBeNull();

    feed(d, e, log.s16BoardOpen);
    expect(ctx(e).registry.seasonal('tartarus')?.active).toBe(true);
    vi.advanceTimersByTime(150_000); // board

    suppress(h);
    expect(ctx(e).registry.seasonal('tartarus')?.active).toBe(true);

    feed(d, e, log.zoneTransition(TOWN, TARTARUS_FIGHT));
    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).mapCount).toBe(0);

    vi.advanceTimersByTime(60_000); // fight + loot room
    feed(d, e, log.bagUpdate(1, 200, 7));
    expect(ctx(e).registry.session?.snapshot().drops[200]).toBe(7);
    expect(ctx(e).registry.seasonal('tartarus')?.snapshot().drops[200]).toBe(7);

    feed(d, e, log.zoneTransition(TARTARUS_FIGHT, TOWN));

    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(ctx(e).mapCount).toBe(0);
    expect(tartarusStarted(events)).toBe(1);
    const finished = tartarusFinished(events);
    expect(finished).toHaveLength(1);
    expect(finished[0].tracker.elapsed).toBe(210_000);
    expect(finished[0].tracker.drops[200]).toBe(7);
  });

  it('the settled-board replay alone starts and finishes nothing', () => {
    const h = setup();
    dismissSettledReplay(h);

    expect(ctx(h.e).registry.seasonalsSize()).toBe(0);
    expect(tartarusStarted(h.events)).toBe(0);
    expect(tartarusFinished(h.events)).toHaveLength(0);
  });

  it('Esc mid-board pauses the run; reopening resumes the same run', () => {
    const h = setup();
    const {d, e, events} = h;

    feed(d, e, log.s16BoardOpen);
    vi.advanceTimersByTime(10_000);
    feed(d, e, log.s16BoardClose);
    expect(ctx(e).registry.seasonal('tartarus')?.active).toBe(false);

    vi.advanceTimersByTime(30_000); // away from the board — not counted
    feed(d, e, log.s16BoardOpen); // reopen: no settled replay, resumes directly
    expect(ctx(e).registry.seasonal('tartarus')?.active).toBe(true);
    expect(tartarusStarted(events)).toBe(1);

    vi.advanceTimersByTime(5_000);
    expect(ctx(e).registry.seasonal('tartarus')?.elapsed()).toBe(15_000);
  });

  it('Ignore on a live board finishes a 0-drop run keeping its board time', () => {
    const h = setup();
    const {d, e, events} = h;

    dismissSettledReplay(h);
    feed(d, e, log.s16BoardOpen);
    vi.advanceTimersByTime(120_000);
    feed(d, e, log.s16Ignore);
    feed(d, e, log.s16BoardClose);

    const finished = tartarusFinished(events);
    expect(finished).toHaveLength(1);
    expect(finished[0].tracker.elapsed).toBe(120_000);
    expect(Object.keys(finished[0].tracker.drops)).toHaveLength(0);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });

  it('Suppress that never reaches the prison finishes on the next zone change', () => {
    const h = setup();
    const {d, e, events} = h;

    feed(d, e, log.s16BoardOpen);
    suppress(h);
    feed(d, e, log.zoneTransition(TOWN, MAP));

    expect(tartarusFinished(events)).toHaveLength(1);
    expect(ctx(e).registry.map?.active).toBe(true);
  });
});

describe('Tartarus started on a map', () => {
  it('board open freezes the map; Esc resumes it', () => {
    const h = setup();
    const {d, e} = h;

    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000);

    dismissSettledReplay(h);
    expect(ctx(e).registry.map?.active).toBe(true); // replay is inert

    feed(d, e, log.s16BoardOpen);
    expect(ctx(e).registry.map?.active).toBe(false);
    vi.advanceTimersByTime(20_000);

    feed(d, e, log.s16BoardClose);
    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).registry.seasonal('tartarus')?.active).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(ctx(e).registry.map?.elapsed()).toBe(15_000);
  });

  it('prison → town: board + fight excluded from map time; loot stays off the map', () => {
    const h = setup();
    const {d, e, events} = h;

    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000);

    feed(d, e, log.s16BoardOpen);
    vi.advanceTimersByTime(30_000);
    suppress(h);
    expect(ctx(e).registry.map?.active).toBe(false); // still frozen through commit

    feed(d, e, log.zoneTransition(MAP, TARTARUS_FIGHT));
    expect(ctx(e).registry.map?.active).toBe(false);
    feed(d, e, log.bagUpdate(1, 200, 3));
    expect(ctx(e).registry.map?.snapshot().drops[200]).toBeUndefined();
    vi.advanceTimersByTime(60_000);

    feed(d, e, log.zoneTransition(TARTARUS_FIGHT, TOWN));

    expect(ctx(e).registry.map).toBeNull();
    expect(ctx(e).accumulatedMapTime).toBe(10_000);
    expect(ctx(e).mapPausedForInterludeAt).toBeNull();
    const finished = tartarusFinished(events);
    expect(finished).toHaveLength(1);
    expect(finished[0].tracker.elapsed).toBe(90_000);
    expect(finished[0].tracker.drops[200]).toBe(3);
  });

  it('prison → back to the map: map resumes and the run ends', () => {
    const h = setup();
    const {d, e, events} = h;

    feed(d, e, log.zoneTransition(TOWN, MAP));
    vi.advanceTimersByTime(10_000);
    feed(d, e, log.s16BoardOpen);
    suppress(h);
    feed(d, e, log.zoneTransition(MAP, TARTARUS_FIGHT));
    vi.advanceTimersByTime(60_000);
    feed(d, e, log.zoneTransition(TARTARUS_FIGHT, MAP));

    expect(tartarusFinished(events)).toHaveLength(1);
    expect(ctx(e).registry.map?.active).toBe(true);
    expect(ctx(e).mapCount).toBe(1); // no second map for the return leg
    vi.advanceTimersByTime(5_000);
    expect(ctx(e).registry.map?.elapsed()).toBe(15_000);
  });
});

describe('Tartarus under session pause', () => {
  it('a board opened while paused starts nothing, but Ignore still finishes a live run', () => {
    const h = setup();
    const {d, e, events} = h;

    e.pause();
    feed(d, e, log.s16BoardOpen);
    expect(ctx(e).registry.seasonal('tartarus')).toBeNull();
    e.resume();

    feed(d, e, log.s16BoardOpen);
    expect(ctx(e).registry.seasonal('tartarus')?.active).toBe(true);
    e.pause();
    feed(d, e, log.s16Ignore);

    expect(tartarusFinished(events)).toHaveLength(1);
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
  });
});
