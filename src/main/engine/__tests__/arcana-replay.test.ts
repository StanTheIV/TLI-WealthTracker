/**
 * Arcana — replay of REAL captured game-log sequences (UE_game.log, 5 runs).
 * Not a unit test of behavior contracts; a guard that the exact marker strings
 * and ordering seen in the wild drive the tracker as intended.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/main/engine/types';
import {boot, createDispatcher, createEngine, ctx, feed} from './seasonal-fixtures';

beforeEach(() => { vi.useFakeTimers(); });

const T = (s: string) => `[2026.07.19-08.07.00:000]TLLua: Display: [Game] ${s}`;
const ZONE = (from: string, to: string) =>
  `PageApplyBase@ _UpdateGameEnd: LastSceneName = World'${from}' NextSceneName = World'${to}'`;

const TOWN  = 'SD_GeBuLinShanZhai';
const FIGHT = '/Game/Art/Season/S9/Maps/SuMingTaLuo/SuMingTaLuo000.SuMingTaLuo000';

describe('Arcana real-log replay', () => {
  it('committed run: minigame → hide/challenge/destory → enter fight → leave fight', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);

    // Exact sequence from run @07.17–07.20 (S9Taro Hide/Destory ignored).
    feed(d, e, T('S9Taro Run'));
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);

    feed(d, e, T('S9Taro Hide'));
    feed(d, e, T('S9Challenge Run'));
    feed(d, e, T('S9Taro Destory'));
    feed(d, e, ZONE(TOWN, FIGHT));
    feed(d, e, T('S9Challenge Destory'));

    // Tracker survived the whole commit sequence, no phantom map tracker.
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
    expect(ctx(e).registry.map).toBeNull();

    // Leave the fight → finish.
    feed(d, e, ZONE(FIGHT, TOWN));
    expect(ctx(e).registry.seasonalsSize()).toBe(0);
    expect(events.some(ev => ev.type === 'tracker_finished' && ev.tracker.seasonalType === 'arcana')).toBe(true);
  });

  it('abandon-then-reopen: Run → Destory → Run keeps a single tracker alive', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);

    // Exact sequence from run @06.47 (opened, closed 3s later, reopened).
    feed(d, e, T('S9Taro Run'));
    feed(d, e, T('S9Taro Destory'));  // ignored — tracker stays
    feed(d, e, T('S9Taro Run'));      // reopen — idempotent, still one tracker

    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
    const started = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'arcana');
    expect(started.length).toBe(1);
  });

  it('backed-out mid-minigame: OnPageBackEvent pauses, later Run resumes', () => {
    const events: EngineEvent[] = [];
    const d = createDispatcher();
    const e = createEngine(events);
    boot(d, e, [{slotId: 1, itemId: 200, quantity: 0}]);

    // Exact sequence from run @09.36 (opened, backed out mid-progress, reopened,
    // then committed to the fight). The back-out is the only genuine close
    // signal — S9Taro Destory fires on both abandon and commit and is ignored.
    feed(d, e, T('S9Taro Run'));
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);

    feed(d, e, T('PageApplyBase@ OnPageBackEvent FuncId = 41700_S9TaroCtrl'));
    feed(d, e, T('S9Taro Destory')); // still ignored
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(false); // paused by the back-out

    feed(d, e, T('S9Taro Run'));      // reopen — resumes
    feed(d, e, T('S9Challenge Run')); // commit
    expect(ctx(e).registry.seasonal('arcana')?.active).toBe(true);
    const started = events.filter(ev => ev.type === 'tracker_started' && ev.tracker.seasonalType === 'arcana');
    expect(started.length).toBe(1); // one tracker throughout
  });
});
