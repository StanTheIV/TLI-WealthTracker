import {describe, it, expect, vi, beforeEach} from 'vitest';
import {BagInitHandler} from '@/main/engine/handlers/bag-init';
import {EngineContext} from '@/main/engine/context';
import type {EmitFn} from '@/main/engine/types';

function makeCtx(): EngineContext {
  const ctx = new EngineContext();
  ctx.phase = 'initializing';
  return ctx;
}

describe('BagInitHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('emits init_started on onStart', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.onStart(ctx, emit);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('init_started');
  });

  it('feeds bag slots to BagState during init', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    handler.onStart(ctx, () => {});

    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 111, quantity: 10}, ctx, () => {});
    handler.handle({type: 'bag_init', pageId: 0, slotId: 2, itemId: 222, quantity: 5},  ctx, () => {});

    expect(ctx.bag.slotCount).toBe(2);
  });

  it('emits init_complete and transitions to tracking after debounce', async () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.onStart(ctx, emit);
    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 111, quantity: 10}, ctx, emit);

    expect(ctx.phase).toBe('initializing');

    vi.advanceTimersByTime(600);

    expect(ctx.phase).toBe('tracking');
    expect(ctx.bag.initialized).toBe(true);
    const complete = events.find(e => e.type === 'init_complete');
    expect(complete).toBeDefined();
    if (complete?.type === 'init_complete') {
      expect(complete.itemCount).toBe(1);
    }
  });

  it('resets debounce timer on each new bag_init', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.onStart(ctx, emit);

    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1}, ctx, emit);
    vi.advanceTimersByTime(300); // not yet expired

    handler.handle({type: 'bag_init', pageId: 0, slotId: 2, itemId: 2, quantity: 1}, ctx, emit);
    vi.advanceTimersByTime(300); // timer reset — still not expired

    expect(ctx.phase).toBe('initializing');

    vi.advanceTimersByTime(300); // now expired (300 + 300 > 500 from last event)

    expect(ctx.phase).toBe('tracking');
    expect(ctx.bag.slotCount).toBe(2);
  });

  it('ignores bag_init events when not in initializing phase', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    ctx.phase = 'tracking';

    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 111, quantity: 10}, ctx, () => {});

    expect(ctx.bag.slotCount).toBe(0);
  });

  it('clears timer on onStop', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.onStart(ctx, emit);
    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1}, ctx, emit);
    handler.onStop(ctx);
    vi.advanceTimersByTime(1000);

    // init_complete should NOT have been emitted
    expect(events.find(e => e.type === 'init_complete')).toBeUndefined();
    expect(ctx.phase).toBe('initializing'); // unchanged — ctx.reset() is engine's job
  });

  describe('new_item emission at boot', () => {
    it('emits new_item for every unknown itemId present in the bag after init', () => {
      const handler = new BagInitHandler();
      const ctx = makeCtx();
      ctx.knownItems = new Set(['111']); // 111 already in DB, 222/333 are new
      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.onStart(ctx, emit);
      handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 111, quantity: 10}, ctx, emit);
      handler.handle({type: 'bag_init', pageId: 0, slotId: 2, itemId: 222, quantity: 5},  ctx, emit);
      handler.handle({type: 'bag_init', pageId: 0, slotId: 3, itemId: 333, quantity: 1},  ctx, emit);
      vi.advanceTimersByTime(600);

      const newItems = events.filter(e => e.type === 'new_item').map(e => e.type === 'new_item' ? e.itemId : -1);
      expect(newItems.sort()).toEqual([222, 333]);
      expect(ctx.knownItems.has('222')).toBe(true);
      expect(ctx.knownItems.has('333')).toBe(true);
    });

    it('does not emit new_item when all bag items are already known', () => {
      const handler = new BagInitHandler();
      const ctx = makeCtx();
      ctx.knownItems = new Set(['111', '222']);
      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.onStart(ctx, emit);
      handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 111, quantity: 10}, ctx, emit);
      handler.handle({type: 'bag_init', pageId: 0, slotId: 2, itemId: 222, quantity: 5},  ctx, emit);
      vi.advanceTimersByTime(600);

      expect(events.filter(e => e.type === 'new_item')).toHaveLength(0);
    });

    it('emits new_item before tracker_started', () => {
      const handler = new BagInitHandler();
      const ctx = makeCtx();
      ctx.knownItems = new Set();
      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.onStart(ctx, emit);
      handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 555, quantity: 1}, ctx, emit);
      vi.advanceTimersByTime(600);

      const types = events.map(e => e.type);
      const newIdx     = types.indexOf('new_item');
      const trackerIdx = types.indexOf('tracker_started');
      expect(newIdx).toBeGreaterThanOrEqual(0);
      expect(trackerIdx).toBeGreaterThan(newIdx);
    });
  });

  describe('continued session restoration', () => {
    it('replays loaded drops and time offset into ctx.session', () => {
      const handler = new BagInitHandler();
      const ctx = makeCtx();
      ctx.loadedSession = {
        id:        'abc',
        name:      'Prior run',
        drops:     {'100': 3, '200': 7},
        totalTime: 120,  // seconds
        mapTime:   30,
        mapCount:  4,
      };

      handler.onStart(ctx, () => {});
      handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1}, ctx, () => {});
      vi.advanceTimersByTime(600);

      const snap = ctx.session?.snapshot();
      expect(snap?.drops[100]).toBe(3);
      expect(snap?.drops[200]).toBe(7);
      expect(snap?.elapsed).toBeGreaterThanOrEqual(120_000);
      expect(ctx.mapCount).toBe(4);
      expect(ctx.accumulatedMapTime).toBe(30_000);
      expect(ctx.activeSessionId).toBe('abc');
      expect(ctx.activeSessionName).toBe('Prior run');
      expect(ctx.loadedSession).toBeNull(); // cleared after merge
    });

    it('emits tracker_started with sessionMeta reflecting loaded mapCount/mapTime', () => {
      const handler = new BagInitHandler();
      const ctx = makeCtx();
      ctx.loadedSession = {
        id:        'abc',
        name:      'Prior',
        drops:     {},
        totalTime: 60,
        mapTime:   15,
        mapCount:  2,
      };
      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.onStart(ctx, emit);
      handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1}, ctx, emit);
      vi.advanceTimersByTime(600);

      const started = events.find(e => e.type === 'tracker_started');
      expect(started).toBeDefined();
      if (started?.type === 'tracker_started') {
        expect(started.tracker.kind).toBe('session');
        expect(started.sessionMeta).toEqual({mapTime: 15_000, mapCount: 2});
      }
    });

    it('emits zero-value sessionMeta for fresh (non-continued) runs', () => {
      const handler = new BagInitHandler();
      const ctx = makeCtx();
      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.onStart(ctx, emit);
      handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1}, ctx, emit);
      vi.advanceTimersByTime(600);

      const started = events.find(e => e.type === 'tracker_started');
      if (started?.type === 'tracker_started') {
        expect(started.sessionMeta).toEqual({mapTime: 0, mapCount: 0});
      }
    });
  });
});
